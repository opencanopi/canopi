//! Test-only, AST-backed policy for native command registration and blocking execution.
//!
//! The Rust test suite parses command modules and the Tauri registry with `syn`, then checks the
//! complete command set against one small synchronous allowlist. Async command bodies may touch
//! managed state outside executor work only through a reviewed allowlist of bounded in-memory
//! operations. Threads and blocking pools are disallowed by clippy (`clippy.toml`); this module
//! checks that list's floor (`ESCAPE_ENTRY_POINTS`), and the push-lane `disallowed-methods`
//! ratchet counts every production escape from it (`policy/adapters/clippy.mjs`).
//! It also checks every registered command against the frontend's `invoke(...)` and `invokeCommand(...)` call sites.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use syn::{
    Attribute, Expr, ExprCall, ExprForLoop, ExprLet, ExprLoop, ExprMethodCall, ExprPath, ExprWhile,
    FnArg, Item, Local, Macro, Pat, Path as SynPath, TypePath,
    parse::Parser,
    punctuated::Punctuated,
    visit::{self, Visit},
};

#[derive(Clone, Copy)]
struct SyncCommandAllowance {
    path: &'static str,
    reason: &'static str,
}

const SYNC_COMMAND_ALLOWLIST: &[SyncCommandAllowance] = &[
    SyncCommandAllowance {
        path: "commands::design::new_design",
        reason: "constructs bounded generated defaults and a timestamp without external I/O",
    },
    SyncCommandAllowance {
        path: "commands::health::get_health",
        reason: "returns a clone of the in-memory health snapshot under its lock; it cannot fail, so it returns SubsystemHealth itself",
    },
    SyncCommandAllowance {
        path: "commands::health::dismiss_store_notice",
        reason: "clears one store's one-time notice in the in-memory health snapshot under its lock; no I/O",
    },
    SyncCommandAllowance {
        path: "commands::host::take_pending_open",
        reason: "takes the one in-memory pending-open value a launch left; no I/O",
    },
    SyncCommandAllowance {
        path: "commands::species::supersede_species_search",
        reason: "delivers a bounded in-memory cancellation signal that must bypass queued Catalog work",
    },
    SyncCommandAllowance {
        path: "commands::update::update_cancel",
        reason: "moves the updater's in-memory cancel generation so a running check or download stops; no I/O",
    },
    SyncCommandAllowance {
        path: "commands::update::update_restart",
        reason: "runs off the main thread (`async`): waits for the writes in flight up to the bounded exit drain deadline, releases the single-instance name, runs Tauri's exit cleanup and spawns the relaunch, then the process exits",
    },
    SyncCommandAllowance {
        path: "commands::lidar::lidar_cancel_analysis_job",
        reason: "delivers a bounded in-memory cancellation flag that must bypass a busy Local raster queue",
    },
];

/// One reviewed operation an async command performs on managed state (`State<...>` or a value
/// derived from it) before or around its executor work. Everything else, including any
/// filesystem, SQLite or network touch, belongs inside the `executor.run(...)` closure.
#[derive(Clone, Copy)]
struct StateAccessAllowance {
    path: &'static str,
    operation: &'static str,
    reason: &'static str,
}

const STATE_ACCESS_ALLOWLIST: &[StateAccessAllowance] = &[
    StateAccessAllowance {
        path: "commands::species::search_species",
        operation: "begin_request",
        reason: "registers the in-memory supersession token before Catalog work is queued",
    },
    StateAccessAllowance {
        path: "commands::species::search_species",
        operation: "interrupt_handle",
        reason: "clones the SQLite interrupt handle; no statement runs",
    },
    StateAccessAllowance {
        path: "commands::lidar::lidar_sample_points",
        operation: "sampling_turn",
        reason: "refuses an over-cap request, then awaits the library's one in-memory sampling permit before a Local slot",
    },
    StateAccessAllowance {
        path: "commands::lidar::lidar_cancel_import",
        operation: "set_cancel_flag",
        reason: "sets the job's in-memory cancellation flag before the item's deletion is queued",
    },
    StateAccessAllowance {
        path: "commands::lidar::lidar_import_item",
        operation: "await_stopping_jobs",
        reason: "awaits, with no executor permit held, until in-memory job flags show no cancelled or settling job still holding the heavy lease",
    },
    StateAccessAllowance {
        path: "commands::lidar::lidar_retry_import",
        operation: "await_stopping_jobs",
        reason: "awaits, with no executor permit held, until in-memory job flags show no cancelled or settling job still holding the heavy lease",
    },
    StateAccessAllowance {
        path: "commands::lidar::lidar_dismiss_import",
        operation: "await_stopping_jobs",
        reason: "awaits, with no executor permit held, until in-memory job flags show no cancelled or settling job still holding the heavy lease",
    },
    StateAccessAllowance {
        path: "commands::lidar::lidar_delete_item",
        operation: "await_jobs_settled",
        reason: "awaits, with no executor permit held, until in-memory job flags show the deleted item's own cancelled jobs have settled",
    },
    StateAccessAllowance {
        path: "commands::design::save_design",
        operation: "record_design_folder",
        reason: "remembers, in memory, the written Design's folder for the window's next host dialog",
    },
    StateAccessAllowance {
        path: "commands::design::load_design",
        operation: "record_design_folder",
        reason: "remembers, in memory, the loaded Design's folder for the window's next host dialog",
    },
    StateAccessAllowance {
        path: "commands::problem_report::create_problem_report",
        operation: "report_health",
        reason: "clones the in-memory startup health snapshot",
    },
];

#[derive(Debug)]
struct CommandFact {
    path: String,
    is_async: bool,
    has_executor_state: bool,
    routes_through_executor: bool,
    awaits_managed_work: bool,
    direct_capabilities: BTreeSet<&'static str>,
    state_accesses: BTreeSet<String>,
}

fn audit_command_policy(
    registry_source: &str,
    command_sources: &[(&str, &str)],
    sync_allowlist: &[SyncCommandAllowance],
    state_allowlist: &[StateAccessAllowance],
) -> Vec<String> {
    let mut violations = Vec::new();
    let registry = match parse_command_registry(registry_source) {
        Ok(registry) => registry,
        Err(error) => {
            violations.push(error);
            return violations;
        }
    };

    let commands = collect_command_facts(command_sources, &mut violations);
    audit_registry(&registry, &commands, &mut violations);
    let allowances = sync_allowances(sync_allowlist, &mut violations);
    let state_allowances = state_allowances(state_allowlist, &mut violations);

    for command in commands.values() {
        if command.is_async {
            audit_async_command(command, &state_allowances, &mut violations);
        } else if !allowances.contains_key(command.path.as_str()) {
            violations.push(format!(
                "unclassified synchronous command: {}",
                command.path
            ));
        } else {
            for capability in &command.direct_capabilities {
                violations.push(format!(
                    "allowlisted synchronous command uses forbidden direct {capability} capability: {}",
                    command.path
                ));
            }
        }
    }

    audit_unused_allowances(&commands, &allowances, &state_allowances, &mut violations);
    violations.sort();
    violations.dedup();
    violations
}

/// Each `#[tauri::command]` function of the command modules by path; a duplicate or a module
/// that fails to parse is a violation.
fn collect_command_facts(
    command_sources: &[(&str, &str)],
    violations: &mut Vec<String>,
) -> BTreeMap<String, CommandFact> {
    let mut commands = BTreeMap::new();
    for (module, source) in command_sources {
        match parse_command_facts(module, source) {
            Ok(facts) => {
                for fact in facts {
                    let path = fact.path.clone();
                    if commands.insert(path.clone(), fact).is_some() {
                        violations.push(format!("duplicate Tauri command: {path}"));
                    }
                }
            }
            Err(error) => violations.push(error),
        }
    }
    commands
}

/// The registry and the annotated functions must name the same commands, each once.
fn audit_registry(
    registry: &[String],
    commands: &BTreeMap<String, CommandFact>,
    violations: &mut Vec<String>,
) {
    let registered = registry.iter().cloned().collect::<BTreeSet<_>>();
    let command_paths = commands.keys().cloned().collect::<BTreeSet<_>>();
    for duplicate in duplicates(registry) {
        violations.push(format!(
            "duplicate native command registry entry: {duplicate}"
        ));
    }
    for path in registered.difference(&command_paths) {
        violations.push(format!(
            "registered native command has no #[tauri::command] function: {path}"
        ));
    }
    for path in command_paths.difference(&registered) {
        violations.push(format!(
            "#[tauri::command] function is missing from the native registry: {path}"
        ));
    }
}

/// The synchronous allowances by command path; a blank reason or a duplicate is a violation.
fn sync_allowances(
    sync_allowlist: &[SyncCommandAllowance],
    violations: &mut Vec<String>,
) -> BTreeMap<&'static str, &'static str> {
    let mut allowances = BTreeMap::new();
    for allowance in sync_allowlist {
        if allowance.reason.trim().is_empty() {
            violations.push(format!(
                "synchronous command allowance has no reason: {}",
                allowance.path
            ));
        }
        if allowances
            .insert(allowance.path, allowance.reason)
            .is_some()
        {
            violations.push(format!(
                "duplicate synchronous command allowance: {}",
                allowance.path
            ));
        }
    }
    allowances
}

/// The managed-state allowances as `(command, operation)`; a blank reason or a duplicate is a
/// violation.
fn state_allowances(
    state_allowlist: &[StateAccessAllowance],
    violations: &mut Vec<String>,
) -> BTreeSet<(&'static str, &'static str)> {
    let mut state_allowances = BTreeSet::new();
    for allowance in state_allowlist {
        if allowance.reason.trim().is_empty() {
            violations.push(format!(
                "managed-state access allowance has no reason: {} ({})",
                allowance.path, allowance.operation
            ));
        }
        if !state_allowances.insert((allowance.path, allowance.operation)) {
            violations.push(format!(
                "duplicate managed-state access allowance: {} ({})",
                allowance.path, allowance.operation
            ));
        }
    }
    state_allowances
}

/// An async command routes its work through the executor it takes, awaits it, reaches no
/// global blocking pool and touches managed state only where an allowance says so.
fn audit_async_command(
    command: &CommandFact,
    state_allowances: &BTreeSet<(&'static str, &'static str)>,
    violations: &mut Vec<String>,
) {
    for operation in &command.state_accesses {
        if !state_allowances.contains(&(command.path.as_str(), operation.as_str())) {
            violations.push(format!(
                "async native command touches managed state outside executor work: {} ({operation})",
                command.path
            ));
        }
    }
    let checks = [
        (
            command.has_executor_state,
            "async native command is missing NativeOperationExecutor state",
        ),
        (
            command.routes_through_executor,
            "async native command does not route work through its executor",
        ),
        (
            command.awaits_managed_work,
            "async native command does not await managed executor work",
        ),
        (
            !command.direct_capabilities.contains("blocking pool"),
            "async native command directly invokes a global blocking pool",
        ),
    ];
    for (holds, message) in checks {
        if !holds {
            violations.push(format!("{message}: {}", command.path));
        }
    }
}

/// An allowance no command uses is stale: a synchronous one naming no command or an async one,
/// a state one naming no async command's access.
fn audit_unused_allowances(
    commands: &BTreeMap<String, CommandFact>,
    allowances: &BTreeMap<&'static str, &'static str>,
    state_allowances: &BTreeSet<(&'static str, &'static str)>,
    violations: &mut Vec<String>,
) {
    for path in allowances.keys() {
        match commands.get(*path) {
            None => violations.push(format!(
                "unused synchronous command allowance has no command: {path}"
            )),
            Some(command) if command.is_async => violations.push(format!(
                "unused synchronous command allowance names an async command: {path}"
            )),
            Some(_) => {}
        }
    }

    for (path, operation) in state_allowances {
        let used = commands
            .get(*path)
            .is_some_and(|command| command.is_async && command.state_accesses.contains(*operation));
        if !used {
            violations.push(format!(
                "unused managed-state access allowance: {path} ({operation})"
            ));
        }
    }
}

fn parse_command_facts(module: &str, source: &str) -> Result<Vec<CommandFact>, String> {
    let file = syn::parse_file(source)
        .map_err(|error| format!("failed to parse commands/{module}.rs: {error}"))?;
    let mut facts = Vec::new();

    for item in file.items {
        let Item::Fn(function) = item else {
            continue;
        };
        if !has_tauri_command_attribute(&function.attrs) {
            continue;
        }

        let mut executor_type = ExecutorTypeVisitor::default();
        for input in &function.sig.inputs {
            executor_type.visit_fn_arg(input);
        }
        let mut body = CommandBodyVisitor::default();
        body.visit_block(&function.block);
        let mut state = StateAccessVisitor::for_inputs(&function.sig.inputs);
        state.visit_block(&function.block);
        facts.push(CommandFact {
            path: format!("commands::{module}::{}", function.sig.ident),
            is_async: function.sig.asyncness.is_some(),
            has_executor_state: executor_type.found,
            routes_through_executor: body.routes_through_executor,
            awaits_managed_work: body.awaits_managed_work,
            direct_capabilities: body.direct_capabilities,
            state_accesses: state.accesses,
        });
    }

    Ok(facts)
}

fn parse_command_registry(source: &str) -> Result<Vec<String>, String> {
    let file = syn::parse_file(source)
        .map_err(|error| format!("failed to parse native command registry source: {error}"))?;
    let mut visitor = CommandRegistryVisitor::default();
    visitor.visit_file(&file);
    if !visitor.errors.is_empty() {
        return Err(visitor.errors.join("; "));
    }
    if visitor.registries != 1 {
        return Err(format!(
            "expected one tauri::generate_handler! registry, found {}",
            visitor.registries
        ));
    }
    Ok(visitor.entries)
}

#[derive(Default)]
struct CommandRegistryVisitor {
    registries: usize,
    entries: Vec<String>,
    errors: Vec<String>,
}

impl<'ast> Visit<'ast> for CommandRegistryVisitor {
    fn visit_macro(&mut self, node: &'ast Macro) {
        if path_segments(&node.path) == ["tauri", "generate_handler"] {
            self.registries += 1;
            let parser = Punctuated::<SynPath, syn::Token![,]>::parse_terminated;
            match parser.parse2(node.tokens.clone()) {
                Ok(paths) => {
                    for path in paths {
                        let path = path_to_string(&path);
                        if !path.starts_with("commands::") {
                            self.errors.push(format!(
                                "native command registry contains a non-command path: {path}"
                            ));
                        }
                        self.entries.push(path);
                    }
                }
                Err(error) => self
                    .errors
                    .push(format!("failed to parse native command registry: {error}")),
            }
        }
        visit::visit_macro(self, node);
    }
}

#[derive(Default)]
struct ExecutorTypeVisitor {
    found: bool,
}

impl<'ast> Visit<'ast> for ExecutorTypeVisitor {
    fn visit_type_path(&mut self, node: &'ast TypePath) {
        if node
            .path
            .segments
            .iter()
            .any(|segment| segment.ident == "NativeOperationExecutor")
        {
            self.found = true;
        }
        visit::visit_type_path(self, node);
    }
}

#[derive(Default)]
struct CommandBodyVisitor {
    routes_through_executor: bool,
    awaits_managed_work: bool,
    direct_capabilities: BTreeSet<&'static str>,
}

impl CommandBodyVisitor {
    fn record_path(&mut self, path: &SynPath) {
        let segments = path_segments(path)
            .into_iter()
            .map(|segment| segment.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let joined = segments.join("::");
        if joined.starts_with("std::fs::") || segments.first().is_some_and(|value| value == "fs") {
            self.direct_capabilities.insert("filesystem");
        }
        if joined.starts_with("std::net::")
            || segments
                .iter()
                .any(|value| matches!(value.as_str(), "tcpstream" | "udpsocket"))
        {
            self.direct_capabilities.insert("network");
        }
        if joined.starts_with("std::process::") {
            self.direct_capabilities.insert("process");
        }
        if joined.starts_with("std::thread::") || joined.starts_with("thread::") {
            self.direct_capabilities.insert("thread");
        }
        if segments.iter().any(|value| {
            matches!(
                value.as_str(),
                "rusqlite" | "connection" | "userdb" | "plantdb"
            )
        }) {
            self.direct_capabilities.insert("SQLite");
        }
        if segments.iter().any(|value| {
            matches!(
                value.as_str(),
                "reqwest" | "ureq" | "http" | "httpsconnector"
            )
        }) {
            self.direct_capabilities.insert("HTTP");
        }
        for segment in &segments {
            self.record_identifier(segment);
        }
    }

    fn record_identifier(&mut self, identifier: &str) {
        let identifier = identifier.to_ascii_lowercase();
        for (fragment, capability) in [
            ("render", "rendering"),
            ("image", "image processing"),
            ("png", "PNG processing"),
            ("pdf", "PDF processing"),
            ("encode", "encoding"),
            ("decode", "decoding"),
            ("compress", "compression"),
            ("archive", "compression"),
            ("zip", "compression"),
        ] {
            if identifier.contains(fragment) {
                self.direct_capabilities.insert(capability);
            }
        }
        if identifier == "sleep" {
            self.direct_capabilities.insert("blocking sleep");
        }
        if matches!(identifier.as_str(), "spawn_blocking" | "block_in_place") {
            self.direct_capabilities.insert("blocking pool");
        }
    }
}

impl<'ast> Visit<'ast> for CommandBodyVisitor {
    fn visit_expr_await(&mut self, node: &'ast syn::ExprAwait) {
        let mut route = ExecutorRouteVisitor::default();
        route.visit_expr(&node.base);
        self.awaits_managed_work |= route.found;
        visit::visit_expr_await(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        if ["run", "run_typed", "inner"].contains(&node.method.to_string().as_str())
            && expression_is_identifier(&node.receiver, "executor")
        {
            self.routes_through_executor = true;
        }
        self.record_identifier(&node.method.to_string());
        visit::visit_expr_method_call(self, node);
    }

    fn visit_expr_path(&mut self, node: &'ast ExprPath) {
        self.record_path(&node.path);
        visit::visit_expr_path(self, node);
    }

    fn visit_type_path(&mut self, node: &'ast TypePath) {
        self.record_path(&node.path);
        visit::visit_type_path(self, node);
    }

    fn visit_expr_loop(&mut self, node: &'ast ExprLoop) {
        self.direct_capabilities.insert("unbounded loop");
        visit::visit_expr_loop(self, node);
    }

    fn visit_expr_while(&mut self, node: &'ast ExprWhile) {
        self.direct_capabilities.insert("unbounded loop");
        visit::visit_expr_while(self, node);
    }

    fn visit_expr_for_loop(&mut self, node: &'ast ExprForLoop) {
        self.direct_capabilities.insert("loop");
        visit::visit_expr_for_loop(self, node);
    }
}

#[derive(Default)]
struct ExecutorRouteVisitor {
    found: bool,
}

impl<'ast> Visit<'ast> for ExecutorRouteVisitor {
    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        if ["run", "run_typed", "inner"].contains(&node.method.to_string().as_str())
            && expression_is_identifier(&node.receiver, "executor")
        {
            self.found = true;
        }
        visit::visit_expr_method_call(self, node);
    }
}

/// Records operations an async command body performs on managed state outside the closures it
/// hands to `executor.run(...)`. A value is managed state when it is a `State<...>` argument
/// (other than the executor) or is bound from an expression that mentions one. Unwrapping
/// (`inner`) and cloning a handle to move it into executor work are not operations; nor is
/// passing it to a call that also receives the executor.
struct StateAccessVisitor {
    managed: BTreeSet<String>,
    executors: BTreeSet<String>,
    accesses: BTreeSet<String>,
}

impl StateAccessVisitor {
    fn for_inputs(inputs: &Punctuated<FnArg, syn::Token![,]>) -> Self {
        let mut visitor = Self {
            managed: BTreeSet::new(),
            executors: BTreeSet::new(),
            accesses: BTreeSet::new(),
        };
        for input in inputs {
            let FnArg::Typed(argument) = input else {
                continue;
            };
            let Pat::Ident(name) = argument.pat.as_ref() else {
                continue;
            };
            let mut executor = ExecutorTypeVisitor::default();
            executor.visit_type(&argument.ty);
            if executor.found {
                visitor.executors.insert(name.ident.to_string());
            } else if type_mentions(&argument.ty, "State") {
                visitor.managed.insert(name.ident.to_string());
            }
        }
        visitor
    }

    fn mentions(&self, expression: &Expr, names: &BTreeSet<String>) -> bool {
        let mut finder = IdentifierFinder {
            names,
            found: false,
        };
        finder.visit_expr(expression);
        finder.found
    }

    fn bind_if_managed(&mut self, pattern: &Pat, init: &Expr) {
        if self.mentions(init, &self.managed) {
            let mut bindings = PatternBindings::default();
            bindings.visit_pat(pattern);
            self.managed.extend(bindings.names);
        }
    }
}

impl<'ast> Visit<'ast> for StateAccessVisitor {
    fn visit_local(&mut self, node: &'ast Local) {
        if let Some(init) = &node.init {
            self.visit_expr(&init.expr);
            if let Some((_, diverge)) = &init.diverge {
                self.visit_expr(diverge);
            }
            self.bind_if_managed(&node.pat, &init.expr);
        }
    }

    fn visit_expr_let(&mut self, node: &'ast ExprLet) {
        self.visit_expr(&node.expr);
        self.bind_if_managed(&node.pat, &node.expr);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        if (node.method == "run" || node.method == "run_typed")
            && receiver_root(&node.receiver).is_some_and(|root| self.executors.contains(&root))
        {
            // The executor closure is the managed boundary; its body is not inspected here.
            self.visit_expr(&node.receiver);
            for argument in &node.args {
                if !matches!(argument, Expr::Closure(_)) {
                    self.visit_expr(argument);
                }
            }
            return;
        }

        let (root, chain) = method_chain(node);
        if root.is_some_and(|root| self.managed.contains(&root)) {
            let operation = chain
                .iter()
                .filter(|method| !matches!(method.as_str(), "inner" | "clone"))
                .cloned()
                .collect::<Vec<_>>();
            if !operation.is_empty() {
                self.accesses.insert(operation.join("."));
            }
            // The receiver chain is reported as one operation; arguments are still inspected.
            let mut receiver = node;
            loop {
                for argument in &receiver.args {
                    self.visit_expr(argument);
                }
                match strip_transparent(&receiver.receiver) {
                    Expr::MethodCall(inner) => receiver = inner,
                    _ => break,
                }
            }
            return;
        }
        visit::visit_expr_method_call(self, node);
    }

    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        if let Expr::Path(function) = node.func.as_ref()
            && let Some(name) = function.path.segments.last().map(|s| s.ident.to_string())
            && !name.starts_with(|c: char| c.is_ascii_uppercase())
            && node
                .args
                .iter()
                .any(|argument| self.mentions(argument, &self.managed))
            && !node
                .args
                .iter()
                .any(|argument| self.mentions(argument, &self.executors))
        {
            self.accesses.insert(name);
        }
        visit::visit_expr_call(self, node);
    }
}

#[derive(Default)]
struct PatternBindings {
    names: Vec<String>,
}

impl<'ast> Visit<'ast> for PatternBindings {
    fn visit_pat_ident(&mut self, node: &'ast syn::PatIdent) {
        self.names.push(node.ident.to_string());
        visit::visit_pat_ident(self, node);
    }
}

struct IdentifierFinder<'a> {
    names: &'a BTreeSet<String>,
    found: bool,
}

impl<'ast> Visit<'ast> for IdentifierFinder<'_> {
    fn visit_expr_path(&mut self, node: &'ast ExprPath) {
        if node.qself.is_none()
            && let Some(ident) = node.path.get_ident()
            && self.names.contains(&ident.to_string())
        {
            self.found = true;
        }
        visit::visit_expr_path(self, node);
    }
}

fn type_mentions(ty: &syn::Type, segment: &str) -> bool {
    struct Finder<'a> {
        segment: &'a str,
        found: bool,
    }
    impl<'ast> Visit<'ast> for Finder<'_> {
        fn visit_type_path(&mut self, node: &'ast TypePath) {
            if node.path.segments.iter().any(|s| s.ident == self.segment) {
                self.found = true;
            }
            visit::visit_type_path(self, node);
        }
    }
    let mut finder = Finder {
        segment,
        found: false,
    };
    finder.visit_type(ty);
    finder.found
}

/// Parentheses, references, `?`, `.await` and field access do not change which value a
/// method is called on.
fn strip_transparent(expression: &Expr) -> &Expr {
    match expression {
        Expr::Paren(inner) => strip_transparent(&inner.expr),
        Expr::Reference(inner) => strip_transparent(&inner.expr),
        Expr::Try(inner) => strip_transparent(&inner.expr),
        Expr::Await(inner) => strip_transparent(&inner.base),
        Expr::Field(inner) => strip_transparent(&inner.base),
        Expr::Unary(inner) => strip_transparent(&inner.expr),
        other => other,
    }
}

fn receiver_root(expression: &Expr) -> Option<String> {
    match strip_transparent(expression) {
        Expr::MethodCall(call) => receiver_root(&call.receiver),
        Expr::Path(path) if path.qself.is_none() => path.path.get_ident().map(ToString::to_string),
        _ => None,
    }
}

/// The root identifier of a method chain and its methods in call order.
fn method_chain(call: &ExprMethodCall) -> (Option<String>, Vec<String>) {
    let mut methods = vec![call.method.to_string()];
    let mut receiver = call.receiver.as_ref();
    loop {
        match strip_transparent(receiver) {
            Expr::MethodCall(inner) => {
                methods.push(inner.method.to_string());
                receiver = inner.receiver.as_ref();
            }
            Expr::Path(path) if path.qself.is_none() => {
                methods.reverse();
                return (path.path.get_ident().map(ToString::to_string), methods);
            }
            _ => {
                methods.reverse();
                return (None, methods);
            }
        }
    }
}

/// Every way to start a thread or reach a blocking pool. `clippy.toml` disallows each one
/// (`disallowed-methods`), and clippy resolves calls by type, so an alias, a re-export, a
/// macro body or a function value is caught as well as a plain call; the Rust gate runs
/// clippy with `-D warnings`. A reviewed escape (the executor's own pool call, Tauri's
/// generated context) carries a statement-level
/// `#[expect(clippy::disallowed_methods, reason = "...")]`, which fails when the escape goes,
/// and each production call it owns is counted in `policy/ratchets/disallowed-methods.json`.
const ESCAPE_ENTRY_POINTS: &[&str] = &[
    "std::thread::spawn",
    "std::thread::scope",
    "std::thread::Builder::spawn",
    "std::thread::Builder::spawn_scoped",
    "tokio::task::spawn_blocking",
    "tokio::task::block_in_place",
    "tokio::runtime::Handle::spawn_blocking",
    "tokio::runtime::Runtime::spawn_blocking",
    "tauri::async_runtime::spawn_blocking",
    "rayon::spawn",
    "rayon::spawn_fifo",
    "rayon::scope",
];

/// The `(path, reason)` pairs of `clippy.toml`'s `disallowed-methods`, one entry per line.
fn disallowed_method_paths(config: &str) -> Vec<(String, String)> {
    let quoted = |line: &str, key: &str| {
        let rest = line.split_once(&format!("{key} = \""))?.1;
        Some(rest.split_once('"')?.0.to_owned())
    };
    let Some((_, list)) = config.split_once("disallowed-methods = [") else {
        return Vec::new();
    };
    let list = list.split_once("\n]").map_or(list, |(list, _)| list);
    list.lines()
        .filter_map(|line| Some((quoted(line, "path")?, quoted(line, "reason")?)))
        .collect()
}

/// Files that belong to an out-of-line `#[cfg(test)] mod name;`, and everything below them.
/// `#[path]` modules are not resolved, so they are scanned as production.
#[derive(Default)]
pub(crate) struct TestModuleFiles {
    files: BTreeSet<String>,
    directories: Vec<String>,
}

impl TestModuleFiles {
    pub(crate) fn collect(&mut self, path: &str, items: &[Item]) {
        let directory = match path.rsplit_once('/') {
            Some((parent, "mod.rs" | "lib.rs" | "main.rs")) => parent.to_owned(),
            Some(_) | None => path.trim_end_matches(".rs").to_owned(),
        };
        self.collect_in(&directory, items, false);
    }

    fn collect_in(&mut self, directory: &str, items: &[Item], inside_test: bool) {
        for item in items {
            let Item::Mod(module) = item else {
                continue;
            };
            let is_test = inside_test || has_cfg_test_attribute(&module.attrs);
            let child = format!("{directory}/{}", module.ident);
            match &module.content {
                Some((_, inner)) => self.collect_in(&child, inner, is_test),
                None if is_test => {
                    self.files.insert(format!("{child}.rs"));
                    self.files.insert(format!("{child}/mod.rs"));
                    self.directories.push(format!("{child}/"));
                }
                None => {}
            }
        }
    }

    pub(crate) fn contains(&self, path: &str) -> bool {
        self.files.contains(path)
            || self
                .directories
                .iter()
                .any(|directory| path.starts_with(directory.as_str()))
    }
}

/// Every registered command has an `invoke` or `invokeCommand('<name>'...)` call site in production
/// frontend source. There are no exemptions: a command nothing invokes is deleted.
fn audit_frontend_invocations(
    registry_source: &str,
    frontend_sources: &[(&str, &str)],
) -> Vec<String> {
    let mut violations = Vec::new();
    let registered = match parse_command_registry(registry_source) {
        Ok(registry) => registry
            .iter()
            .filter_map(|path| path.rsplit("::").next().map(str::to_owned))
            .collect::<BTreeSet<_>>(),
        Err(error) => return vec![error],
    };
    let invoked = frontend_sources
        .iter()
        .flat_map(|(_, source)| invoked_command_names(source))
        .collect::<BTreeSet<_>>();

    for name in &registered {
        if !invoked.contains(name) {
            violations.push(format!(
                "registered native command is never invoked by the frontend: {name}"
            ));
        }
    }
    violations.sort();
    violations
}

/// Command names of `invoke('name', ...)` / `invoke<T>("name")` / `invokeCommand('name')` call sites.
fn invoked_command_names(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut names = Vec::new();
    let mut search = 0;
    while let Some(offset) = source[search..].find("invoke") {
        let start = search + offset;
        search = start + "invoke".len();
        search += "Command".len() * usize::from(source[search..].starts_with("Command"));
        if start > 0 && is_identifier_byte(bytes[start - 1]) {
            continue;
        }
        let mut cursor = skip_whitespace(bytes, search);
        if bytes.get(cursor) == Some(&b'<') {
            let mut depth = 0usize;
            while let Some(&byte) = bytes.get(cursor) {
                cursor += 1;
                match byte {
                    b'<' => depth += 1,
                    b'>' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
            }
            cursor = skip_whitespace(bytes, cursor);
        }
        if bytes.get(cursor) != Some(&b'(') {
            continue;
        }
        cursor = skip_whitespace(bytes, cursor + 1);
        let Some(&quote) = bytes
            .get(cursor)
            .filter(|byte| matches!(byte, b'\'' | b'"' | b'`'))
        else {
            continue;
        };
        let name_start = cursor + 1;
        let mut name_end = name_start;
        while bytes
            .get(name_end)
            .is_some_and(|byte| is_identifier_byte(*byte))
        {
            name_end += 1;
        }
        if name_end > name_start && bytes.get(name_end) == Some(&quote) {
            names.push(source[name_start..name_end].to_owned());
        }
    }
    names
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

fn skip_whitespace(bytes: &[u8], mut cursor: usize) -> usize {
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    cursor
}

/// Production frontend source: TypeScript outside `__tests__/` and `*.test.*` files.
fn is_production_frontend_source(relative: &Path) -> bool {
    let is_typescript = relative
        .extension()
        .is_some_and(|extension| extension == "ts" || extension == "tsx");
    let is_test = relative
        .components()
        .any(|component| component.as_os_str() == "__tests__")
        || relative
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains(".test."));
    is_typescript && !is_test
}

fn frontend_sources_under(root: &Path, path: &Path, sources: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            frontend_sources_under(root, &path, sources);
        } else if is_production_frontend_source(path.strip_prefix(root).unwrap()) {
            let relative = path.strip_prefix(root).unwrap().display().to_string();
            sources.push((relative, fs::read_to_string(&path).unwrap()));
        }
    }
}

fn audit_repository() -> Vec<String> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let source_root = manifest.join("src");
    let commands_root = source_root.join("commands");
    let registry_source = fs::read_to_string(source_root.join("lib.rs")).unwrap();

    let mut owned_command_sources = fs::read_dir(&commands_root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "rs"))
        .filter(|path| path.file_stem().is_some_and(|stem| stem != "mod"))
        .map(|path| {
            let module = path.file_stem().unwrap().to_string_lossy().into_owned();
            let source = fs::read_to_string(path).unwrap();
            (module, source)
        })
        .collect::<Vec<_>>();
    owned_command_sources.sort_by(|left, right| left.0.cmp(&right.0));
    let command_sources = owned_command_sources
        .iter()
        .map(|(module, source)| (module.as_str(), source.as_str()))
        .collect::<Vec<_>>();

    let mut violations = audit_command_policy(
        &registry_source,
        &command_sources,
        SYNC_COMMAND_ALLOWLIST,
        STATE_ACCESS_ALLOWLIST,
    );

    let frontend_root = manifest.join("web").join("src");
    let mut owned_frontend_sources = Vec::new();
    frontend_sources_under(&frontend_root, &frontend_root, &mut owned_frontend_sources);
    let frontend_sources = owned_frontend_sources
        .iter()
        .map(|(path, source)| (path.as_str(), source.as_str()))
        .collect::<Vec<_>>();
    violations.extend(audit_frontend_invocations(
        &registry_source,
        &frontend_sources,
    ));
    if source_root.join("blocking.rs").exists() {
        violations.push("obsolete unbounded blocking helper still exists: src/blocking.rs".into());
    }
    violations.sort();
    violations.dedup();
    violations
}

fn has_tauri_command_attribute(attributes: &[Attribute]) -> bool {
    attributes
        .iter()
        .any(|attribute| path_segments(attribute.path()) == ["tauri", "command"])
}

pub(crate) fn has_cfg_test_attribute(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        attribute.path().is_ident("cfg")
            && attribute
                .parse_args::<syn::Ident>()
                .is_ok_and(|argument| argument == "test")
    })
}

fn expression_is_identifier(expression: &Expr, expected: &str) -> bool {
    matches!(
        expression,
        Expr::Path(path) if path.qself.is_none() && path.path.is_ident(expected)
    )
}

fn path_segments(path: &SynPath) -> Vec<String> {
    path.segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect()
}

fn path_to_string(path: &SynPath) -> String {
    path.segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

/// Every Rust source under the crate's `src/`, sorted, as (path relative to the crate with '/', as on Windows too,
/// source text): what the repository audits read.
pub(crate) fn crate_rust_sources() -> Vec<(String, String)> {
    rust_sources_in(Path::new(env!("CARGO_MANIFEST_DIR")))
}

/// Every Rust source under `manifest/src`, sorted, as (path relative to `manifest` with '/', source text).
pub(crate) fn rust_sources_in(manifest: &Path) -> Vec<(String, String)> {
    let mut paths = Vec::new();
    rust_sources_under(&manifest.join("src"), &mut paths);
    read_sorted(manifest, paths)
}

/// Every Rust source under each workspace member's `src/`, sorted, as (path relative to the workspace with '/',
/// source text). The members are the root manifest's one-line `members = [...]` list.
fn workspace_rust_sources() -> Vec<(String, String)> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let manifest = fs::read_to_string(workspace.join("Cargo.toml")).unwrap();
    let members = manifest
        .lines()
        .find_map(|line| line.trim().strip_prefix("members = ["))
        .and_then(|rest| rest.strip_suffix(']'))
        .expect("the workspace manifest lists its members on one `members = [...]` line");
    let mut paths = Vec::new();
    for member in members
        .split(',')
        .map(|member| member.trim().trim_matches('"'))
    {
        rust_sources_under(&workspace.join(member).join("src"), &mut paths);
    }
    read_sorted(workspace, paths)
}

/// Each path, sorted, as (path relative to `root` with '/', as on Windows too, source text).
fn read_sorted(root: &Path, mut paths: Vec<PathBuf>) -> Vec<(String, String)> {
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let source = fs::read_to_string(&path).unwrap();
            (relative, source)
        })
        .collect()
}

/// The `cargo llvm-cov --ignore-filename-regex` that leaves test-only code out of Rust coverage (2.1-Q19): every
/// file of an out-of-line `#[cfg(test)] mod x;` and every file below one, by name, so a new test-only file changes
/// the measured file set only through a reviewed edit of policy/ratchets/coverage.json.
fn coverage_exclusion(sources: &[(String, String)]) -> String {
    let mut test_modules = TestModuleFiles::default();
    for (path, source) in sources {
        let file = syn::parse_file(source).unwrap_or_else(|error| panic!("{path}: {error}"));
        test_modules.collect(path, &file.items);
    }
    let files: Vec<String> = sources
        .iter()
        .filter(|(path, _)| test_modules.contains(path))
        .map(|(path, _)| path.replace('.', "\\."))
        .collect();
    format!("(^|/)({})$", files.join("|"))
}

fn rust_sources_under(path: &Path, sources: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_sources_under(&path, sources);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            sources.push(path);
        }
    }
}

fn duplicates(values: &[String]) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    values
        .iter()
        .filter_map(|value| (!seen.insert(value.clone())).then_some(value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        ESCAPE_ENTRY_POINTS, StateAccessAllowance, SyncCommandAllowance, audit_command_policy,
        audit_frontend_invocations, audit_repository, coverage_exclusion, disallowed_method_paths,
        invoked_command_names, is_production_frontend_source, workspace_rust_sources,
    };
    use std::path::Path;

    #[test]
    fn unclassified_synchronous_command_fixture_is_rejected() {
        let violations = audit_command_policy(
            "tauri::generate_handler![commands::fixture::read_file];",
            &[(
                "fixture",
                r#"
                    #[tauri::command]
                    pub fn read_file() -> Result<Vec<u8>, String> {
                        std::fs::read("fixture").map_err(|error| error.to_string())
                    }
                "#,
            )],
            &[],
            &[],
        );

        assert_eq!(
            violations,
            ["unclassified synchronous command: commands::fixture::read_file"]
        );
    }

    #[test]
    fn allowlist_cannot_hide_direct_blocking_capabilities() {
        let allowance = [SyncCommandAllowance {
            path: "commands::fixture::read_file",
            reason: "deliberately invalid fixture",
        }];
        let violations = audit_command_policy(
            "tauri::generate_handler![commands::fixture::read_file];",
            &[(
                "fixture",
                "#[tauri::command] pub fn read_file() { std::fs::read(\"fixture\"); }",
            )],
            &allowance,
            &[],
        );

        assert_eq!(
            violations,
            [
                "allowlisted synchronous command uses forbidden direct filesystem capability: commands::fixture::read_file"
            ]
        );
    }

    #[test]
    fn allowlist_rejects_every_forbidden_effect_family() {
        let allowance = [SyncCommandAllowance {
            path: "commands::fixture::effect",
            reason: "deliberately invalid fixture",
        }];
        for (body, expected_capability) in [
            ("std::fs::read(\"fixture\");", "filesystem"),
            ("rusqlite::Connection::open_in_memory();", "SQLite"),
            ("std::net::TcpStream::connect(\"localhost:1\");", "network"),
            ("render_pdf();", "rendering"),
            ("compress_archive();", "compression"),
            ("while ready() { work(); }", "unbounded loop"),
        ] {
            let source = format!("#[tauri::command] pub fn effect() {{ {body} }}");
            let violations = audit_command_policy(
                "tauri::generate_handler![commands::fixture::effect];",
                &[("fixture", source.as_str())],
                &allowance,
                &[],
            );

            assert!(
                violations
                    .iter()
                    .any(|violation| violation.contains(expected_capability)),
                "{body}: {violations:?}"
            );
        }
    }

    #[test]
    fn async_command_fixture_requires_and_uses_the_managed_executor() {
        let violations = audit_command_policy(
            "tauri::generate_handler![commands::fixture::read_file];",
            &[(
                "fixture",
                "#[tauri::command] pub async fn read_file() { ready().await; }",
            )],
            &[],
            &[],
        );

        assert_eq!(
            violations,
            [
                "async native command does not await managed executor work: commands::fixture::read_file",
                "async native command does not route work through its executor: commands::fixture::read_file",
                "async native command is missing NativeOperationExecutor state: commands::fixture::read_file",
            ]
        );
    }

    #[test]
    fn async_command_cannot_accept_an_executor_without_awaiting_managed_work() {
        let violations = audit_command_policy(
            "tauri::generate_handler![commands::fixture::fake_async];",
            &[(
                "fixture",
                "#[tauri::command] pub async fn fake_async(executor: State<'_, NativeOperationExecutor>) { let _ = executor; }",
            )],
            &[],
            &[],
        );

        assert_eq!(
            violations,
            [
                "async native command does not await managed executor work: commands::fixture::fake_async",
                "async native command does not route work through its executor: commands::fixture::fake_async",
            ]
        );
    }

    #[test]
    fn awaiting_unrelated_work_does_not_make_an_async_command_executor_backed() {
        let violations = audit_command_policy(
            "tauri::generate_handler![commands::fixture::fake_async];",
            &[(
                "fixture",
                "#[tauri::command] pub async fn fake_async(executor: State<'_, NativeOperationExecutor>) { let _ = executor; ready().await; }",
            )],
            &[],
            &[],
        );

        assert_eq!(
            violations,
            [
                "async native command does not await managed executor work: commands::fixture::fake_async",
                "async native command does not route work through its executor: commands::fixture::fake_async",
            ]
        );
    }

    #[test]
    fn executor_work_must_be_the_future_that_is_awaited() {
        let violations = audit_command_policy(
            "tauri::generate_handler![commands::fixture::fake_async];",
            &[(
                "fixture",
                r#"
                    #[tauri::command]
                    pub async fn fake_async(
                        executor: State<'_, NativeOperationExecutor>,
                    ) {
                        let _ = executor.run(NativeOperationClass::Local, "fake", || Ok(()));
                        ready().await;
                    }
                "#,
            )],
            &[],
            &[],
        );

        assert_eq!(
            violations,
            [
                "async native command does not await managed executor work: commands::fixture::fake_async"
            ]
        );
    }

    #[test]
    fn stale_allowlist_entries_are_rejected() {
        let allowance = [SyncCommandAllowance {
            path: "commands::fixture::removed",
            reason: "stale fixture",
        }];
        let violations = audit_command_policy("tauri::generate_handler![];", &[], &allowance, &[]);

        assert_eq!(
            violations,
            ["unused synchronous command allowance has no command: commands::fixture::removed"]
        );
    }

    #[test]
    fn command_annotations_and_registry_must_match_exactly() {
        let violations = audit_command_policy(
            "tauri::generate_handler![commands::fixture::registered_only];",
            &[("fixture", "#[tauri::command] pub fn annotated_only() {}")],
            &[],
            &[],
        );

        assert_eq!(
            violations,
            [
                "#[tauri::command] function is missing from the native registry: commands::fixture::annotated_only",
                "registered native command has no #[tauri::command] function: commands::fixture::registered_only",
                "unclassified synchronous command: commands::fixture::annotated_only",
            ]
        );
    }

    #[test]
    fn clippy_disallows_every_thread_and_blocking_pool_entry_point() {
        let config = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("clippy.toml"),
        )
        .unwrap();
        let disallowed = disallowed_method_paths(&config);
        let missing = ESCAPE_ENTRY_POINTS
            .iter()
            .filter(|entry| !disallowed.iter().any(|(path, _)| path == *entry))
            .collect::<Vec<_>>();
        assert!(
            missing.is_empty(),
            "clippy.toml does not disallow {missing:?}"
        );
        let unexplained = disallowed
            .iter()
            .filter(|(_, reason)| reason.trim().is_empty())
            .collect::<Vec<_>>();
        assert!(unexplained.is_empty(), "{unexplained:?}");
    }

    /// Contracts §18, 2.1-M189: each `clippy.toml` disallowed-methods reason is its R row's
    /// `<id>: <owner_today> (example <example>)` from `policy/primitives.json`, every thread and
    /// blocking-pool entry point cites the R2 blocking row, and every disallowed-methods row is
    /// cited, so an owner moved in the table cannot leave clippy naming the old one.
    #[test]
    fn clippy_reasons_read_their_primitive_rows() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let read = |file: &str| std::fs::read_to_string(root.join(file)).unwrap();
        let table: serde_json::Value =
            serde_json::from_str(&read("policy/primitives.json")).unwrap();
        let rows = table["rules"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["family"] == "disallowed-methods")
            .map(|row| {
                let field = |name: &str| row[name].as_str().unwrap_or("(missing)").to_owned();
                let reason = format!(
                    "{}: {} (example {})",
                    field("id"),
                    field("owner_today"),
                    field("example")
                );
                (field("id"), reason)
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        let disallowed = disallowed_method_paths(&read("clippy.toml"));
        let row_of = |path: &str, reason: &str| {
            if ESCAPE_ENTRY_POINTS.contains(&path) {
                "blocking-only-in-executor".to_owned()
            } else {
                reason.split_once(':').map_or("", |(id, _)| id).to_owned()
            }
        };
        let drift = disallowed
            .iter()
            .filter(|(path, reason)| rows.get(&row_of(path, reason)) != Some(reason))
            .map(|(path, reason)| format!("{path}: {reason}"))
            .collect::<Vec<_>>();
        assert!(
            drift.is_empty(),
            "write each reason from its primitives.json row ({rows:?}): {drift:?}"
        );
        let uncited = rows
            .keys()
            .filter(|id| {
                !disallowed
                    .iter()
                    .any(|(path, reason)| row_of(path, reason) == **id)
            })
            .collect::<Vec<_>>();
        assert!(uncited.is_empty(), "no clippy.toml entry cites {uncited:?}");
    }

    /// 2.1-Q19: the cargo-llvm-cov exclusion is derived, never hand-kept.
    #[test]
    fn the_coverage_exclusion_names_every_test_only_file() {
        let coverage: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../policy/ratchets/coverage.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let recorded = &coverage["floors"]["cargo-llvm-cov"]["exclude"];
        let derived = coverage_exclusion(&workspace_rust_sources());
        assert_eq!(
            recorded,
            &serde_json::json!([derived]),
            "policy/ratchets/coverage.json's cargo-llvm-cov exclude, the gate's --ignore-filename-regex, must be the \
             derived regex; re-measure the floors for the new file set (2.1-Q19)"
        );
    }

    #[test]
    fn the_coverage_exclusion_follows_test_modules_and_their_files() {
        // A later entry for the same path replaces the earlier one.
        let sources = |extra: &[(&str, &str)]| {
            let tree: std::collections::BTreeMap<String, String> = [
                (
                    "desktop/src/lib.rs",
                    "#[cfg(test)] mod policy; mod services;",
                ),
                ("desktop/src/policy.rs", ""),
                (
                    "desktop/src/services/mod.rs",
                    "#[cfg(test)] mod tests; mod live;",
                ),
                ("desktop/src/services/live.rs", ""),
                ("desktop/src/services/tests/mod.rs", "mod deep;"),
                ("desktop/src/services/tests/deep.rs", ""),
            ]
            .iter()
            .chain(extra)
            .map(|(path, source)| ((*path).to_owned(), (*source).to_owned()))
            .collect();
            coverage_exclusion(&tree.into_iter().collect::<Vec<_>>())
        };
        assert_eq!(
            sources(&[]),
            r"(^|/)(desktop/src/policy\.rs|desktop/src/services/tests/deep\.rs|desktop/src/services/tests/mod\.rs)$"
        );
        // A new test-only module, and a new file below a test module, each change the exclusion.
        let new_module = sources(&[
            ("desktop/src/services/live/checks.rs", ""),
            (
                "desktop/src/services/mod.rs",
                "#[cfg(test)] mod tests; mod live; #[cfg(test)] mod checks;",
            ),
            ("desktop/src/services/checks.rs", ""),
        ]);
        assert!(
            new_module.contains(r"desktop/src/services/checks\.rs|"),
            "{new_module}"
        );
        assert!(!new_module.contains("live"), "{new_module}");
        let new_child = sources(&[("desktop/src/services/tests/more.rs", "")]);
        assert!(
            new_child.contains(r"|desktop/src/services/tests/more\.rs)$"),
            "{new_child}"
        );
    }

    #[test]
    fn comments_and_literals_cannot_manufacture_command_or_blocking_facts() {
        let violations = audit_command_policy(
            "tauri::generate_handler![commands::fixture::real];",
            &[(
                "fixture",
                r##"
                    // #[tauri::command] pub fn commented_out() {}
                    const TEXT: &str = r#"#[tauri::command] pub fn literal() { spawn_blocking(); }"#;
                    #[tauri::command]
                    pub async fn real(
                        executor: tauri::State<'_, NativeOperationExecutor>,
                    ) {
                        executor.run(NativeOperationClass::Local, "real", || Ok(())).await;
                    }
                "##,
            )],
            &[],
            &[],
        );

        assert!(violations.is_empty(), "{violations:?}");
    }

    #[test]
    fn filesystem_probe_before_executor_work_is_rejected() {
        // The shape `get_cached_image_path` had: a cache-hit `fs::metadata` probe on the async
        // runtime thread before the executor was reached.
        let violations = audit_command_policy(
            "tauri::generate_handler![commands::fixture::cached_path];",
            &[(
                "fixture",
                r#"
                    #[tauri::command]
                    pub async fn cached_path(
                        cache: State<'_, ImageCache>,
                        executor: State<'_, NativeOperationExecutor>,
                        url: String,
                    ) -> Result<String, String> {
                        if let Some(path) = cache.cached_path_if_present(&url) {
                            return Ok(path);
                        }
                        let cache = cache.inner().clone();
                        executor
                            .run(NativeOperationClass::Network, "fetch", move || {
                                cache.fetch_and_cache(&url)
                            })
                            .await
                    }
                "#,
            )],
            &[],
            &[],
        );

        assert_eq!(
            violations,
            [
                "async native command touches managed state outside executor work: commands::fixture::cached_path (cached_path_if_present)"
            ]
        );
    }

    #[test]
    fn managed_state_derived_bindings_and_free_calls_are_tracked() {
        let violations = audit_command_policy(
            "tauri::generate_handler![commands::fixture::derived];",
            &[(
                "fixture",
                r#"
                    #[tauri::command]
                    pub async fn derived(
                        db: tauri::State<'_, PlantDb>,
                        executor: State<'_, NativeOperationExecutor>,
                    ) -> Result<(), String> {
                        let db = db.inner().clone();
                        let status = db.status();
                        let _ = crate::services::probe(&db);
                        helper_with_executor(executor.inner(), db.clone()).await
                    }
                "#,
            )],
            &[],
            &[],
        );

        assert_eq!(
            violations,
            [
                "async native command touches managed state outside executor work: commands::fixture::derived (probe)",
                "async native command touches managed state outside executor work: commands::fixture::derived (status)",
            ]
        );
    }

    #[test]
    fn reviewed_state_access_passes_and_stale_allowances_are_rejected() {
        let allowance = [
            StateAccessAllowance {
                path: "commands::fixture::cancel_aware",
                operation: "begin_request",
                reason: "bounded in-memory token",
            },
            StateAccessAllowance {
                path: "commands::fixture::cancel_aware",
                operation: "removed_operation",
                reason: "stale fixture",
            },
        ];
        let violations = audit_command_policy(
            "tauri::generate_handler![commands::fixture::cancel_aware];",
            &[(
                "fixture",
                r#"
                    #[tauri::command]
                    pub async fn cancel_aware(
                        tokens: State<'_, Tokens>,
                        executor: State<'_, NativeOperationExecutor>,
                    ) -> Result<(), String> {
                        let token = tokens.inner().begin_request();
                        executor.run(NativeOperationClass::Catalog, "work", move || token.run()).await
                    }
                "#,
            )],
            &[],
            &allowance,
        );

        assert_eq!(
            violations,
            [
                "unused managed-state access allowance: commands::fixture::cancel_aware (removed_operation)"
            ]
        );
    }

    #[test]
    fn invoke_call_sites_are_recognised_in_every_quoting_style() {
        let names = invoked_command_names(
            r#"
                invoke('single', { a }) invokeCommand('routed', { a })
                await invoke<string>("double", { path }) await invokeCommand<T>("typed")
                invoke(
                  `template`,
                )
                reinvoke('not_a_call') reinvokeCommand('not_a_call') invokeCommands('not_a_call')
                invoke(dynamicName) invokeCommand(dynamicName)
            "#,
        );
        assert_eq!(names, ["single", "routed", "double", "typed", "template"]);
    }

    #[test]
    fn registered_commands_must_be_invoked_by_production_frontend_source() {
        let registry = "tauri::generate_handler![commands::a::used, commands::b::dead];";
        let violations = audit_frontend_invocations(
            registry,
            &[
                ("ipc/a.ts", "export const a = () => invoke('used')"),
                ("ipc/b.ts", "export const b = () => reinvoke('dead')"),
            ],
        );

        assert_eq!(
            violations,
            ["registered native command is never invoked by the frontend: dead"]
        );
        assert!(is_production_frontend_source(Path::new("ipc/species.ts")));
        assert!(is_production_frontend_source(Path::new("components/A.tsx")));
        assert!(!is_production_frontend_source(Path::new(
            "__tests__/ipc.test.ts"
        )));
        assert!(!is_production_frontend_source(Path::new(
            "canvas/runtime.test.ts"
        )));
        assert!(!is_production_frontend_source(Path::new(
            "generated/artifact.mjs"
        )));
    }

    #[test]
    fn repository_native_commands_follow_the_execution_policy() {
        let violations = audit_repository();

        assert!(
            violations.is_empty(),
            "native command execution policy violations:\n{}",
            violations.join("\n")
        );
    }
}
