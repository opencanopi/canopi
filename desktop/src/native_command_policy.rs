//! Test-only, AST-backed policy for native command registration and blocking execution.
//!
//! The Rust test suite parses command modules and the Tauri registry with `syn`, then checks the
//! complete command set against one small synchronous allowlist. Async command bodies may touch
//! managed state outside executor work only through a reviewed allowlist of bounded in-memory
//! operations. Threads and blocking pools are disallowed by clippy (`clippy.toml`); this module
//! checks that list, that every production exemption from it is one statement's reasoned
//! `#[expect]`, and that each such escape is pinned in the reviewed `BLOCKING_ESCAPE_ALLOWLIST`.
//! It also checks every registered command against the frontend's `invoke(...)` call sites.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use syn::{
    AttrStyle, Attribute, Expr, ExprCall, ExprForLoop, ExprLet, ExprLit, ExprLoop, ExprMethodCall,
    ExprPath, ExprWhile, FnArg, Item, ItemFn, ItemMod, Lit, Local, Macro, Meta, Pat,
    Path as SynPath, Stmt, TypePath,
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
        reason: "clones the immutable startup health snapshot",
    },
    SyncCommandAllowance {
        path: "commands::species::supersede_species_search",
        reason: "delivers a bounded in-memory cancellation signal that must bypass queued Catalog work",
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
        path: "commands::problem_report::create_problem_report",
        operation: "get_health",
        reason: "clones the immutable startup health snapshot",
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
        if matches!(node.method.to_string().as_str(), "run" | "inner")
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
        if matches!(node.method.to_string().as_str(), "run" | "inner")
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
        if node.method == "run"
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
/// clippy with `-D warnings`. A reviewed escape (the executor's own pool call, the folder
/// opener's reaper, Tauri's generated context) carries a statement-level
/// `#[expect(clippy::disallowed_methods, reason = "...")]`, which fails when the escape goes,
/// and is listed in `BLOCKING_ESCAPE_ALLOWLIST`.
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

/// One reviewed escape from `clippy::disallowed_methods`: the file, the call the exempted
/// statement makes (`path` for a function, `.method` for a method, `path!` for a macro) and
/// the exact reason its `#[expect]` gives. A new escape fails until it is listed here, and an
/// entry whose escape is gone fails as stale.
#[derive(Clone, Copy)]
struct EscapeAllowance {
    path: &'static str,
    escape: &'static str,
    reason: &'static str,
}

const BLOCKING_ESCAPE_ALLOWLIST: &[EscapeAllowance] = &[
    EscapeAllowance {
        path: "src/lib.rs",
        escape: "tauri::generate_context!",
        reason: "Tauri's generated context builds itself on a startup thread it joins at once",
    },
    EscapeAllowance {
        path: "src/native_operation.rs",
        escape: "tauri::async_runtime::spawn_blocking",
        reason: "the executor owns the blocking pool; every native operation reaches it here",
    },
    EscapeAllowance {
        path: "src/services/folder_reveal.rs",
        escape: ".spawn",
        reason: "the opener may live as long as the file manager; holding an executor slot for it would starve bounded work",
    },
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

/// Production attributes that switch `clippy::disallowed_methods` off, directly or through a
/// group (`clippy::style`, `clippy::all`, `warnings`). Each must be one statement's
/// `#[expect(clippy::disallowed_methods, reason = "...")]`, and that statement holds no closure,
/// block or nested macro, so a new escape beside or inside a reviewed one still fails clippy.
/// The only wider switch is the crate root's `TEST_THREADS_SWITCH`, which frees tests to use
/// threads; the bare form without its reason is refused like any other.
fn audit_escape_exemptions(sources: &[(&str, &str)]) -> Vec<String> {
    scan_escape_exemptions(sources).0
}

/// The crate root's one test-wide switch, as `render_attribute` prints it: an inner attribute,
/// so `clippy::allow_attributes` leaves it, with the reason `allow_attributes_without_reason`
/// asks for (2.1-Q216).
const TEST_THREADS_SWITCH: &str = r#"#![cfg_attr(test, allow(clippy::disallowed_methods, reason = "tests may start threads freely"))]"#;

/// Every reasoned escape in production must match one `BLOCKING_ESCAPE_ALLOWLIST` entry, and
/// every entry one escape. An escape whose call names one of `other_disallowed` (clippy.toml's
/// disallowed methods that start no thread and reach no pool, such as `catch_unwind`) answers
/// to its own rule and needs no row (`starts_no_thread`).
fn audit_escape_allowlist(
    sources: &[(&str, &str)],
    allowlist: &[EscapeAllowance],
    other_disallowed: &[&str],
) -> Vec<String> {
    let found = scan_escape_exemptions(sources).1;
    let mut violations = Vec::new();
    for escape in found
        .iter()
        .filter(|escape| !starts_no_thread(escape.escape.as_deref(), other_disallowed))
    {
        if !allowlist.iter().any(|entry| escape.matches(entry)) {
            violations.push(format!(
                "a reviewed escape is missing from BLOCKING_ESCAPE_ALLOWLIST: {} ({})",
                escape.path, escape.reason
            ));
        }
    }
    for entry in allowlist {
        match found.iter().filter(|escape| escape.matches(entry)).count() {
            0 => violations.push(format!(
                "stale BLOCKING_ESCAPE_ALLOWLIST entry: {} ({})",
                entry.path, entry.escape
            )),
            1 => {}
            count => violations.push(format!(
                "a BLOCKING_ESCAPE_ALLOWLIST entry covers {count} escapes, not one: {} ({})",
                entry.path, entry.escape
            )),
        }
    }
    violations.sort();
    violations.dedup();
    violations
}

/// Whether an exempted statement's call is one of `other_disallowed` and no escape entry point,
/// read by its last path segment. A macro, a call no name of `other_disallowed` matches (an
/// alias, a function value) and a name shared with an entry point (`.spawn`) all fail closed:
/// they still need their `BLOCKING_ESCAPE_ALLOWLIST` row.
fn starts_no_thread(call: Option<&str>, other_disallowed: &[&str]) -> bool {
    let Some(call) = call.filter(|call| !call.ends_with('!')) else {
        return false;
    };
    let last = |path: &str| -> String {
        path.trim_start_matches('.')
            .rsplit("::")
            .next()
            .unwrap_or_default()
            .to_owned()
    };
    let name = last(call);
    !ESCAPE_ENTRY_POINTS.iter().any(|entry| last(entry) == name)
        && other_disallowed.iter().any(|other| last(other) == name)
}

/// A statement's reasoned `#[expect(clippy::disallowed_methods, ...)]`, as found in a file.
struct ReviewedEscape {
    path: String,
    escape: Option<String>,
    reason: String,
}

impl ReviewedEscape {
    fn matches(&self, entry: &EscapeAllowance) -> bool {
        self.path == entry.path
            && self.escape.as_deref() == Some(entry.escape)
            && self.reason == entry.reason
    }
}

fn scan_escape_exemptions(sources: &[(&str, &str)]) -> (Vec<String>, Vec<ReviewedEscape>) {
    let mut reviewed = Vec::new();
    let mut violations = Vec::new();
    let mut parsed = Vec::new();
    for (path, source) in sources {
        match syn::parse_file(source) {
            Ok(file) => parsed.push((*path, file)),
            Err(error) => violations.push(format!(
                "failed to parse {path} for escape exemptions: {error}"
            )),
        }
    }
    let mut test_modules = TestModuleFiles::default();
    for (path, file) in &parsed {
        test_modules.collect(path, &file.items);
    }
    for (path, file) in &parsed {
        if test_modules.contains(path) {
            continue;
        }
        let mut visitor = EscapeExemptionVisitor::default();
        if *path == "src/lib.rs" {
            visitor.accepted.extend(
                file.attrs
                    .iter()
                    .filter(|attribute| render_attribute(attribute) == TEST_THREADS_SWITCH)
                    .map(|attribute| attribute as *const Attribute),
            );
        }
        visitor.visit_file(file);
        violations.extend(visitor.refused.into_iter().map(|attribute| {
            format!(
                "an exemption from clippy::disallowed_methods must be one statement's #[expect] with a reason: {path} ({attribute})"
            )
        }));
        violations.extend(visitor.nested.into_iter().map(|attribute| {
            format!(
                "an exempted statement must hold no closure, block or nested macro, or code inside it escapes clippy: {path} ({attribute})"
            )
        }));
        reviewed.extend(
            visitor
                .reviewed
                .into_iter()
                .map(|(escape, reason)| ReviewedEscape {
                    path: (*path).to_owned(),
                    escape,
                    reason,
                }),
        );
    }
    violations.sort();
    violations.dedup();
    (violations, reviewed)
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

#[derive(Default)]
struct EscapeExemptionVisitor {
    /// The crate root's test-only switch.
    accepted: BTreeSet<*const Attribute>,
    /// Attributes on a single statement, where an `#[expect]` may sit.
    statements: BTreeSet<*const Attribute>,
    refused: Vec<String>,
    /// Reviewed escapes whose statement carries code the expectation would also cover.
    nested: Vec<String>,
    /// Each reasoned statement-level escape: the call it makes and its reason.
    reviewed: Vec<(Option<String>, String)>,
}

impl<'ast> Visit<'ast> for EscapeExemptionVisitor {
    fn visit_item_mod(&mut self, node: &'ast ItemMod) {
        if has_cfg_test_attribute(&node.attrs) {
            return;
        }
        visit::visit_item_mod(self, node);
    }

    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        if has_cfg_test_attribute(&node.attrs) {
            return;
        }
        visit::visit_item_fn(self, node);
    }

    fn visit_stmt(&mut self, node: &'ast Stmt) {
        let attributes: &[Attribute] = match node {
            Stmt::Local(local) => &local.attrs,
            Stmt::Macro(statement) => &statement.attrs,
            Stmt::Expr(expression, _) => statement_expression_attributes(expression),
            Stmt::Item(_) => &[],
        };
        self.statements.extend(
            attributes
                .iter()
                .map(|attribute| attribute as *const Attribute),
        );
        for attribute in attributes {
            if let Some(reason) = escape_expect_reason(attribute) {
                self.reviewed.push((statement_call(node), reason));
            }
        }
        if statement_holds_nested_code(node) {
            self.nested.extend(
                attributes
                    .iter()
                    .filter(|attribute| {
                        switches_off_escape_lint(attribute) && is_reasoned_escape_expect(attribute)
                    })
                    .map(render_attribute),
            );
        }
        visit::visit_stmt(self, node);
    }

    fn visit_attribute(&mut self, node: &'ast Attribute) {
        let pointer = node as *const Attribute;
        if !switches_off_escape_lint(node) || self.accepted.contains(&pointer) {
            return;
        }
        if !(self.statements.contains(&pointer) && is_reasoned_escape_expect(node)) {
            self.refused.push(render_attribute(node));
        }
    }
}

fn statement_expression_attributes(expression: &Expr) -> &[Attribute] {
    match expression {
        Expr::Call(inner) => &inner.attrs,
        Expr::MethodCall(inner) => &inner.attrs,
        Expr::Try(inner) => &inner.attrs,
        Expr::Await(inner) => &inner.attrs,
        Expr::Assign(inner) => &inner.attrs,
        Expr::Macro(inner) => &inner.attrs,
        _ => &[],
    }
}

/// `clippy::disallowed_methods`, its former name, and the lint groups that contain it.
const ESCAPE_LINT_NAMES: &[&str] = &[
    "clippy::disallowed_methods",
    "clippy::disallowed_method",
    "clippy::style",
    "clippy::all",
    "warnings",
];

/// Whether the attribute names the escape lint or a group holding it, at any nesting depth
/// (`cfg_attr(..., allow(...))`). A reason string never counts.
fn switches_off_escape_lint(attribute: &Attribute) -> bool {
    let Meta::List(list) = &attribute.meta else {
        return false;
    };
    let Ok(arguments) = list.parse_args_with(Punctuated::<Meta, syn::Token![,]>::parse_terminated)
    else {
        // Unparseable arguments: refuse on the text, never let them through.
        let rendered = render_attribute(attribute);
        return ESCAPE_LINT_NAMES.iter().any(|lint| rendered.contains(lint));
    };
    arguments.iter().any(names_escape_lint)
}

fn names_escape_lint(meta: &Meta) -> bool {
    match meta {
        Meta::Path(path) => ESCAPE_LINT_NAMES.contains(&path_to_string(path).as_str()),
        Meta::List(list) => list
            .parse_args_with(Punctuated::<Meta, syn::Token![,]>::parse_terminated)
            .map_or_else(
                |_| {
                    let tokens = list.tokens.to_string().replace(" :: ", "::");
                    ESCAPE_LINT_NAMES.iter().any(|lint| tokens.contains(lint))
                },
                |nested| nested.iter().any(names_escape_lint),
            ),
        Meta::NameValue(_) => false,
    }
}

/// Code an expectation on this statement would also cover: a closure, block, async block or a
/// macro below the statement's own expression. The statement may itself be one macro call with
/// no arguments (`tauri::generate_context!()`), the thing under review; clippy reports a macro's
/// arguments at their own source, so a macro with arguments counts as nested code.
fn statement_holds_nested_code(statement: &Stmt) -> bool {
    let expression: &Expr = match statement {
        Stmt::Local(local) => match &local.init {
            Some(init) if init.diverge.is_some() => return true,
            Some(init) => &init.expr,
            None => return false,
        },
        Stmt::Expr(expression, _) => expression,
        Stmt::Macro(statement) => return !statement.mac.tokens.is_empty(),
        Stmt::Item(_) => return false,
    };
    if let Expr::Macro(call) = expression {
        return !call.mac.tokens.is_empty();
    }
    let mut finder = NestedCodeFinder::default();
    finder.visit_expr(expression);
    finder.found
}

#[derive(Default)]
struct NestedCodeFinder {
    found: bool,
}

impl<'ast> Visit<'ast> for NestedCodeFinder {
    fn visit_expr_closure(&mut self, _: &'ast syn::ExprClosure) {
        self.found = true;
    }

    fn visit_block(&mut self, _: &'ast syn::Block) {
        self.found = true;
    }

    fn visit_macro(&mut self, _: &'ast Macro) {
        self.found = true;
    }
}

fn is_reasoned_escape_expect(attribute: &Attribute) -> bool {
    escape_expect_reason(attribute).is_some()
}

/// The call an exempted statement makes, as `BLOCKING_ESCAPE_ALLOWLIST` names it: `path` for a
/// function, `.method` for a method and `path!` for a macro, looking through `?` and `.await`.
fn statement_call(statement: &Stmt) -> Option<String> {
    let mut expression: &Expr = match statement {
        Stmt::Local(local) => &local.init.as_ref()?.expr,
        Stmt::Expr(expression, _) => expression,
        Stmt::Macro(statement) => return Some(format!("{}!", path_to_string(&statement.mac.path))),
        Stmt::Item(_) => return None,
    };
    loop {
        match expression {
            Expr::Try(inner) => expression = &inner.expr,
            Expr::Await(inner) => expression = &inner.base,
            Expr::Call(call) => match call.func.as_ref() {
                Expr::Path(path) => return Some(path_to_string(&path.path)),
                _ => return None,
            },
            Expr::MethodCall(call) => return Some(format!(".{}", call.method)),
            Expr::Macro(call) => return Some(format!("{}!", path_to_string(&call.mac.path))),
            _ => return None,
        }
    }
}

/// The non-blank reason of `#[expect(clippy::disallowed_methods, reason = "...")]`.
fn escape_expect_reason(attribute: &Attribute) -> Option<String> {
    if !attribute.path().is_ident("expect") {
        return None;
    }
    let Ok(arguments) =
        attribute.parse_args_with(Punctuated::<Meta, syn::Token![,]>::parse_terminated)
    else {
        return None;
    };
    let mut lints = Vec::new();
    let mut reason = None;
    for argument in arguments {
        match argument {
            Meta::Path(path) => lints.push(path_to_string(&path)),
            Meta::NameValue(pair) if pair.path.is_ident("reason") => {
                if let Expr::Lit(ExprLit {
                    lit: Lit::Str(text),
                    ..
                }) = pair.value
                {
                    reason = Some(text.value());
                }
            }
            Meta::NameValue(_) | Meta::List(_) => return None,
        }
    }
    if lints != ["clippy::disallowed_methods"] {
        return None;
    }
    reason.filter(|text| !text.trim().is_empty())
}

/// `#[name(arguments)]` with the token spacing tidied, for messages and exact matches.
fn render_attribute(attribute: &Attribute) -> String {
    let bang = match attribute.style {
        AttrStyle::Inner(_) => "!",
        AttrStyle::Outer => "",
    };
    let name = path_to_string(attribute.path());
    let body = match &attribute.meta {
        Meta::List(list) => format!(
            "({})",
            list.tokens
                .to_string()
                .replace(" :: ", "::")
                .replace(" , ", ", ")
                .replace(" (", "(")
        ),
        Meta::Path(_) | Meta::NameValue(_) => String::new(),
    };
    format!("#{bang}[{name}{body}]")
}

/// Every registered command must have an `invoke('<name>'...)` call site in
/// production frontend source. There are no exemptions: a command nothing
/// invokes is deleted.
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

/// Command names of `invoke('name', ...)` / `invoke<T>("name")` call sites.
fn invoked_command_names(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut names = Vec::new();
    let mut search = 0;
    while let Some(offset) = source[search..].find("invoke") {
        let start = search + offset;
        search = start + "invoke".len();
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

    let owned_rust_sources = crate_rust_sources();
    let rust_sources = owned_rust_sources
        .iter()
        .map(|(path, source)| (path.as_str(), source.as_str()))
        .collect::<Vec<_>>();
    violations.extend(audit_escape_exemptions(&rust_sources));
    let clippy_config = fs::read_to_string(manifest.join("..").join("clippy.toml")).unwrap();
    let other_disallowed = disallowed_method_paths(&clippy_config)
        .into_iter()
        .map(|(path, _)| path)
        .filter(|path| !ESCAPE_ENTRY_POINTS.contains(&path.as_str()))
        .collect::<Vec<_>>();
    let other_disallowed = other_disallowed
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    violations.extend(audit_escape_allowlist(
        &rust_sources,
        BLOCKING_ESCAPE_ALLOWLIST,
        &other_disallowed,
    ));
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
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut paths = Vec::new();
    rust_sources_under(&manifest.join("src"), &mut paths);
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let relative = path
                .strip_prefix(manifest)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let source = fs::read_to_string(&path).unwrap();
            (relative, source)
        })
        .collect()
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
        ESCAPE_ENTRY_POINTS, EscapeAllowance, StateAccessAllowance, SyncCommandAllowance,
        audit_command_policy, audit_escape_allowlist, audit_escape_exemptions,
        audit_frontend_invocations, audit_repository, disallowed_method_paths,
        invoked_command_names, is_production_frontend_source,
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

    #[test]
    fn escape_exemptions_cover_one_reviewed_statement() {
        let exemption = |name: &str| {
            format!(
                "an exemption from clippy::disallowed_methods must be one statement's #[expect] with a reason: src/services/fixture.rs ({name})"
            )
        };
        let violations = audit_escape_exemptions(&[
            (
                "src/services/fixture.rs",
                r#"
                    fn reviewed() {
                        #[expect(clippy::disallowed_methods, reason = "reaps the opener")]
                        let reaper = std::thread::Builder::new().spawn(work);
                        #[expect(clippy::disallowed_methods, reason = "joined at once")]
                        std::thread::Builder::new().spawn(work)?;
                    }
                    #[expect(clippy::disallowed_methods, reason = "covers every thread below")]
                    fn whole_function() { std::thread::spawn(work); std::thread::spawn(heavy); }
                    impl Opener {
                        #[allow(clippy::disallowed_methods)]
                        fn method(&self) { std::thread::spawn(work); }
                    }
                    fn unexplained() {
                        #[expect(clippy::disallowed_methods)]
                        let thread = std::thread::spawn(work);
                        #[expect(clippy::disallowed_methods, reason = " ")]
                        let blank = std::thread::spawn(work);
                        #[allow(clippy::style)]
                        let grouped = std::thread::spawn(work);
                    }
                    #[cfg(test)]
                    mod tests {
                        #![allow(clippy::disallowed_methods)]
                    }
                "#,
            ),
            (
                "src/lib.rs",
                "#![cfg_attr(test, allow(clippy::disallowed_methods, reason = \"tests may start threads freely\"))]\nmod services;",
            ),
            (
                "src/services/mod.rs",
                "#![cfg_attr(test, allow(clippy::disallowed_methods))]\nmod fixture;",
            ),
        ]);

        assert_eq!(
            violations,
            [
                exemption("#[allow(clippy::disallowed_methods)]"),
                exemption("#[allow(clippy::style)]"),
                exemption("#[expect(clippy::disallowed_methods)]"),
                exemption(r#"#[expect(clippy::disallowed_methods, reason = " ")]"#),
                exemption(
                    r#"#[expect(clippy::disallowed_methods, reason = "covers every thread below")]"#
                ),
                "an exemption from clippy::disallowed_methods must be one statement's #[expect] with a reason: src/services/mod.rs (#![cfg_attr(test, allow(clippy::disallowed_methods))])".to_owned(),
            ]
        );
    }

    #[test]
    fn every_reviewed_escape_is_pinned_in_the_allowlist() {
        let allowlist = [
            EscapeAllowance {
                path: "src/services/fixture.rs",
                escape: ".spawn",
                reason: "reaps the opener",
            },
            EscapeAllowance {
                path: "src/lib.rs",
                escape: "tauri::generate_context!",
                reason: "joined at once",
            },
            EscapeAllowance {
                path: "src/services/fixture.rs",
                escape: "tokio::task::spawn_blocking",
                reason: "the escape was deleted",
            },
        ];
        let violations = audit_escape_allowlist(
            &[
                (
                    "src/services/fixture.rs",
                    r#"
                        fn reviewed() {
                            #[expect(clippy::disallowed_methods, reason = "reaps the opener")]
                            let reaper = std::thread::Builder::new().name(name).spawn(reap);
                            #[expect(clippy::disallowed_methods, reason = "faster")]
                            let handle = std::thread::spawn(work);
                        }
                    "#,
                ),
                (
                    "src/lib.rs",
                    r#"
                        fn run() {
                            #[expect(clippy::disallowed_methods, reason = "joined at once")]
                            let context = tauri::generate_context!();
                            #[expect(clippy::disallowed_methods, reason = "reaps the opener")]
                            let reaper = std::thread::Builder::new().spawn(reap);
                        }
                    "#,
                ),
            ],
            &allowlist,
            &[],
        );

        assert_eq!(
            violations,
            [
                "a reviewed escape is missing from BLOCKING_ESCAPE_ALLOWLIST: src/lib.rs (reaps the opener)",
                "a reviewed escape is missing from BLOCKING_ESCAPE_ALLOWLIST: src/services/fixture.rs (faster)",
                "stale BLOCKING_ESCAPE_ALLOWLIST entry: src/services/fixture.rs (tokio::task::spawn_blocking)",
            ]
        );
    }

    #[test]
    fn one_allowlist_entry_covers_exactly_one_escape() {
        let allowlist = [EscapeAllowance {
            path: "src/services/fixture.rs",
            escape: ".spawn",
            reason: "reaps the opener",
        }];
        let violations = audit_escape_allowlist(
            &[(
                "src/services/fixture.rs",
                r#"
                    fn reviewed() {
                        #[expect(clippy::disallowed_methods, reason = "reaps the opener")]
                        let reaper = std::thread::Builder::new().spawn(reap);
                        #[expect(clippy::disallowed_methods, reason = "reaps the opener")]
                        let second = std::thread::Builder::new().spawn(reap);
                    }
                "#,
            )],
            &allowlist,
            &[],
        );

        assert_eq!(
            violations,
            [
                "a BLOCKING_ESCAPE_ALLOWLIST entry covers 2 escapes, not one: src/services/fixture.rs (.spawn)"
            ]
        );
    }

    #[test]
    fn an_exempted_statement_holds_no_code_of_its_own() {
        let nested = |name: &str| {
            format!(
                "an exempted statement must hold no closure, block or nested macro, or code inside it escapes clippy: src/services/fixture.rs ({name})"
            )
        };
        let violations = audit_escape_exemptions(&[(
            "src/services/fixture.rs",
            r#"
                fn nested() {
                    #[expect(clippy::disallowed_methods, reason = "a closure with a block")]
                    let reaper = std::thread::Builder::new().spawn(move || { std::thread::spawn(heavy); });
                    #[expect(clippy::disallowed_methods, reason = "a closure with an expression")]
                    let pool = tokio::task::spawn_blocking(|| std::thread::spawn(heavy));
                    #[expect(clippy::disallowed_methods, reason = "a nested macro")]
                    std::thread::Builder::new().spawn(hide!(heavy))?;
                    #[expect(clippy::disallowed_methods, reason = "an async block")]
                    let task = runtime.spawn_blocking(async { heavy() });
                    #[expect(clippy::disallowed_methods, reason = "a macro statement with arguments")]
                    wrap!(|| std::thread::spawn(heavy));
                    #[expect(clippy::disallowed_methods, reason = "a macro binding with arguments")]
                    let wrapped = wrap!(move || { std::thread::spawn(heavy) });
                    #[expect(clippy::disallowed_methods, reason = "the reviewed macro itself")]
                    let context = tauri::generate_context!();
                    let reap = move || child.wait();
                    #[expect(clippy::disallowed_methods, reason = "a named closure")]
                    let spawned = std::thread::Builder::new().name("reaper".to_owned()).spawn(reap);
                }
            "#,
        )]);

        assert_eq!(
            violations,
            [
                nested(
                    r#"#[expect(clippy::disallowed_methods, reason = "a closure with a block")]"#
                ),
                nested(
                    r#"#[expect(clippy::disallowed_methods, reason = "a closure with an expression")]"#
                ),
                nested(
                    r#"#[expect(clippy::disallowed_methods, reason = "a macro binding with arguments")]"#
                ),
                nested(
                    r#"#[expect(clippy::disallowed_methods, reason = "a macro statement with arguments")]"#
                ),
                nested(r#"#[expect(clippy::disallowed_methods, reason = "a nested macro")]"#),
                nested(r#"#[expect(clippy::disallowed_methods, reason = "an async block")]"#),
            ]
        );
    }

    #[test]
    fn production_code_cannot_switch_every_warning_off() {
        let exemption = |name: &str| {
            format!(
                "an exemption from clippy::disallowed_methods must be one statement's #[expect] with a reason: src/services/fixture.rs ({name})"
            )
        };
        let violations = audit_escape_exemptions(&[(
            "src/services/fixture.rs",
            r#"
                #![allow(warnings)]
                #[allow(warnings)]
                fn hidden() { std::thread::spawn(heavy); }
                #[cfg_attr(not(test), allow(warnings))]
                fn conditional() { std::thread::spawn(heavy); }
                #[allow(clippy::disallowed_method)]
                fn renamed() { std::thread::spawn(heavy); }
                #[allow(dead_code, reason = "warnings about clippy::all stay on")]
                fn unused() {}
            "#,
        )]);

        assert_eq!(
            violations,
            [
                exemption("#![allow(warnings)]"),
                exemption("#[allow(clippy::disallowed_method)]"),
                exemption("#[allow(warnings)]"),
                exemption("#[cfg_attr(not(test), allow(warnings))]"),
            ]
        );
    }

    #[test]
    fn out_of_line_test_module_files_are_not_audited_for_exemptions() {
        let exempt =
            "#[allow(clippy::disallowed_methods)] fn helper() { std::thread::spawn(work); }";
        let violations = audit_escape_exemptions(&[
            (
                "src/services/fixture.rs",
                "#[cfg(test)] mod tests; mod live;",
            ),
            ("src/services/fixture/tests.rs", exempt),
            ("src/services/fixture/tests/deep.rs", exempt),
            ("src/services/fixture/live.rs", exempt),
            ("src/services/other/mod.rs", "#[cfg(test)] mod checks;"),
            ("src/services/other/checks/mod.rs", exempt),
        ]);

        assert_eq!(
            violations,
            [
                "an exemption from clippy::disallowed_methods must be one statement's #[expect] with a reason: src/services/fixture/live.rs (#[allow(clippy::disallowed_methods)])"
            ]
        );
    }

    #[test]
    fn the_crate_roots_test_switch_is_accepted_only_with_its_reason() {
        let reasoned = audit_escape_exemptions(&[(
            "src/lib.rs",
            "#![cfg_attr(test, allow(clippy::disallowed_methods, reason = \"tests may start threads freely\"))]\nmod services;",
        )]);
        assert!(reasoned.is_empty(), "{reasoned:?}");

        let bare = audit_escape_exemptions(&[(
            "src/lib.rs",
            "#![cfg_attr(test, allow(clippy::disallowed_methods))]\nmod services;",
        )]);
        assert_eq!(
            bare,
            [
                "an exemption from clippy::disallowed_methods must be one statement's #[expect] with a reason: src/lib.rs (#![cfg_attr(test, allow(clippy::disallowed_methods))])"
            ]
        );
    }

    #[test]
    fn an_escape_from_a_method_that_starts_no_thread_needs_no_allowlist_row() {
        let violations = audit_escape_allowlist(
            &[(
                "src/native_operation.rs",
                r#"
                    fn settle() {
                        #[expect(clippy::disallowed_methods, reason = "contains the panic")]
                        let settled = catch_unwind(AssertUnwindSafe(work));
                        #[expect(clippy::disallowed_methods, reason = "contains it again")]
                        let again = std::panic::catch_unwind(AssertUnwindSafe(work));
                        #[expect(clippy::disallowed_methods, reason = "an alias")]
                        let aliased = guard(AssertUnwindSafe(work));
                        #[expect(clippy::disallowed_methods, reason = "a thread")]
                        let thread = std::thread::Builder::new().spawn(work);
                        #[expect(clippy::disallowed_methods, reason = "a macro")]
                        let context = tauri::generate_context!();
                    }
                "#,
            )],
            &[],
            &["std::panic::catch_unwind"],
        );

        assert_eq!(
            violations,
            [
                "a reviewed escape is missing from BLOCKING_ESCAPE_ALLOWLIST: src/native_operation.rs (a macro)",
                "a reviewed escape is missing from BLOCKING_ESCAPE_ALLOWLIST: src/native_operation.rs (a thread)",
                "a reviewed escape is missing from BLOCKING_ESCAPE_ALLOWLIST: src/native_operation.rs (an alias)",
            ]
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
                invoke('single', { a })
                await invoke<string>("double_quoted", { path })
                invoke(
                  `template`,
                )
                reinvoke('not_a_call')
                invoke(dynamicName)
            "#,
        );
        assert_eq!(names, ["single", "double_quoted", "template"]);
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
