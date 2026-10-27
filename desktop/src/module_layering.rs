//! Test-only layer policy for the native modules (P50).
//!
//! Production code under `design/` and `db/` names nothing in `crate::services`, and production
//! code under `services/` names nothing in `crate::commands` and never `AppHealth`. The test parses
//! each file with `syn`, resolves `crate::`, `self::` and `super::` paths in `use` trees,
//! expressions, types and macro bodies (read as tokens), and skips inline `#[cfg(test)]` code and out-of-line
//! `#[cfg(test)]` modules. Each current breach is a named exception with its 2.1 bead; an exception
//! that excuses nothing fails, so a fixed breach must leave the list.
//!
//! The same reading builds the crate's module graph for ADR 0023's `rust-scc` ratchet: one node per
//! production source file's module, an edge to the longest known module prefix of each path it names
//! (`crate::`, `self::`, `super::`, or a bare path through a child module), and Tarjan's algorithm
//! over it. Each module in a component of two or more is a cycle site; the ignored
//! `report_module_cycles` prints them for `policy/adapters/rust-module-graph.mjs`.

use std::collections::BTreeSet;

use syn::{
    Attribute, Expr, ImplItem, Item, ItemMod, ItemUse, Macro, Stmt, TraitItem, UseTree,
    buffer::Cursor,
    parse::ParseStream,
    visit::{self, Visit},
};

use crate::native_command_policy::{TestModuleFiles, crate_rust_sources, has_cfg_test_attribute};

#[derive(Clone, Copy)]
struct LayerException {
    /// The file, relative to the crate manifest, with '/'.
    path: &'static str,
    /// The forbidden name as the violation reports it.
    name: &'static str,
    bead: &'static str,
    reason: &'static str,
}

const LAYER_EXCEPTIONS: &[LayerException] = &[
    LayerException {
        path: "src/design/mod.rs",
        name: "crate::services::lidar::grid::sha256_hex",
        bead: "canopi-f47t.52.20",
        reason: "the Design fingerprint shares the LiDAR grid's SHA-256 until it moves to a leaf hash module",
    },
    LayerException {
        path: "src/services/health.rs",
        name: "AppHealth",
        bead: "canopi-f47t.52.20",
        reason: "the startup health snapshot lives in the crate root until it moves to services/health.rs",
    },
];

/// A layer whose production files must not name a forbidden part of the crate.
#[derive(Clone, Copy)]
enum Layer {
    /// `design/**` and `db/**`: no `crate::services`.
    Domain,
    /// `services/**`: no `crate::commands`, no `AppHealth`.
    Services,
}

fn layer_of(path: &str) -> Option<Layer> {
    if path.starts_with("src/design/") || path.starts_with("src/db/") {
        Some(Layer::Domain)
    } else if path.starts_with("src/services/") {
        Some(Layer::Services)
    } else {
        None
    }
}

/// The module path of a source file: `src/design/mod.rs` is `design`, `src/db/user_db.rs` is
/// `db::user_db`, `src/lib.rs` the crate root.
pub(crate) fn module_path_of(path: &str) -> Vec<String> {
    let relative = path.trim_start_matches("src/").trim_end_matches(".rs");
    let mut segments = relative.split('/').map(str::to_owned).collect::<Vec<_>>();
    if matches!(
        segments.last().map(String::as_str),
        Some("mod" | "lib" | "main")
    ) {
        segments.pop();
    }
    segments
}

fn audit_layering(sources: &[(&str, &str)], exceptions: &[LayerException]) -> Vec<String> {
    let mut violations = BTreeSet::new();
    let mut parsed = Vec::new();
    for (path, source) in sources {
        match syn::parse_file(source) {
            Ok(file) => parsed.push((*path, file)),
            Err(error) => {
                violations.insert(format!("failed to parse {path} for layering: {error}"));
            }
        }
    }
    let mut test_modules = TestModuleFiles::default();
    for (path, file) in &parsed {
        test_modules.collect(path, &file.items);
    }

    let mut used = vec![false; exceptions.len()];
    for (path, file) in &parsed {
        let Some(layer) = layer_of(path) else {
            continue;
        };
        if test_modules.contains(path) {
            continue;
        }
        let mut visitor = NameVisitor {
            module: module_path_of(path),
            names: BTreeSet::new(),
        };
        visitor.visit_file(file);
        for name in visitor.names {
            let Some(rule) = forbidden(layer, &name) else {
                continue;
            };
            let rendered = rule.rendered_name(&name);
            match exceptions
                .iter()
                .position(|exception| exception.path == *path && exception.name == rendered)
            {
                Some(index) => used[index] = true,
                None => {
                    violations.insert(format!("{}: {path} names {rendered}", rule.message()));
                }
            }
        }
    }
    for (exception, used) in exceptions.iter().zip(used) {
        if !used {
            violations.insert(format!(
                "unused layering exception: {} names {} ({}; {})",
                exception.path, exception.name, exception.bead, exception.reason
            ));
        }
    }
    violations.into_iter().collect()
}

#[derive(Clone, Copy)]
enum Breach {
    DomainNamesServices,
    ServicesNameCommands,
    ServicesNameAppHealth,
}

impl Breach {
    fn message(self) -> &'static str {
        match self {
            Self::DomainNamesServices => "design and db code must not name crate::services",
            Self::ServicesNameCommands => "services code must not name crate::commands",
            Self::ServicesNameAppHealth => "services code must not name AppHealth",
        }
    }

    fn rendered_name(self, name: &Name) -> String {
        match self {
            Self::ServicesNameAppHealth => "AppHealth".to_owned(),
            Self::DomainNamesServices | Self::ServicesNameCommands => {
                format!(
                    "crate::{}",
                    name.resolved
                        .as_deref()
                        .expect("forbidden() names a crate path only once resolved")
                        .join("::")
                )
            }
        }
    }
}

fn forbidden(layer: Layer, name: &Name) -> Option<Breach> {
    let first = name
        .resolved
        .as_ref()
        .and_then(|resolved| resolved.first())
        .map(String::as_str);
    match layer {
        Layer::Domain => (first == Some("services")).then_some(Breach::DomainNamesServices),
        Layer::Services if first == Some("commands") => Some(Breach::ServicesNameCommands),
        Layer::Services => name
            .segments
            .iter()
            .any(|segment| segment == "AppHealth")
            .then_some(Breach::ServicesNameAppHealth),
    }
}

/// A path as written, and, when it starts with `crate`, `self` or `super`, its segments from the
/// crate root.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Name {
    segments: Vec<String>,
    resolved: Option<Vec<String>>,
}

impl Name {
    fn new(module: &[String], segments: Vec<String>) -> Self {
        let resolved = resolve(module, &segments);
        Self { segments, resolved }
    }
}

fn resolve(module: &[String], segments: &[String]) -> Option<Vec<String>> {
    let (first, rest) = segments.split_first()?;
    match first.as_str() {
        "crate" => Some(rest.to_vec()),
        "self" => Some(module.iter().chain(rest).cloned().collect()),
        "super" => {
            let mut base = module.to_vec();
            base.pop()?;
            let mut rest = rest;
            while let Some((next, after)) = rest.split_first() {
                if next != "super" {
                    break;
                }
                base.pop()?;
                rest = after;
            }
            Some(base.into_iter().chain(rest.iter().cloned()).collect())
        }
        _ => None,
    }
}

struct NameVisitor {
    /// The module the visitor is in, from the crate root.
    module: Vec<String>,
    names: BTreeSet<Name>,
}

impl NameVisitor {
    fn record(&mut self, segments: Vec<String>) {
        self.names.insert(Name::new(&self.module, segments));
    }

    fn record_use_tree(&mut self, prefix: &mut Vec<String>, tree: &UseTree) {
        match tree {
            UseTree::Path(path) => {
                prefix.push(path.ident.to_string());
                self.record_use_tree(prefix, &path.tree);
                prefix.pop();
            }
            UseTree::Name(name) => self.record_use_leaf(prefix, name.ident.to_string()),
            UseTree::Rename(rename) => self.record_use_leaf(prefix, rename.ident.to_string()),
            UseTree::Glob(_) => self.record_use_leaf(prefix, "*".to_owned()),
            UseTree::Group(group) => {
                for tree in &group.items {
                    self.record_use_tree(prefix, tree);
                }
            }
        }
    }

    fn record_use_leaf(&mut self, prefix: &[String], leaf: String) {
        let mut segments = prefix.to_vec();
        // `use crate::services::{self}` names `crate::services`.
        if leaf != "self" {
            segments.push(leaf);
        }
        self.record(segments);
    }
}

impl<'ast> Visit<'ast> for NameVisitor {
    fn visit_item(&mut self, node: &'ast Item) {
        if !has_cfg_test_attribute(item_attributes(node)) {
            visit::visit_item(self, node);
        }
    }

    fn visit_item_mod(&mut self, node: &'ast ItemMod) {
        self.module.push(node.ident.to_string());
        visit::visit_item_mod(self, node);
        self.module.pop();
    }

    fn visit_item_use(&mut self, node: &'ast ItemUse) {
        // A leading `::` names an external crate.
        if node.leading_colon.is_none() {
            self.record_use_tree(&mut Vec::new(), &node.tree);
        }
    }

    fn visit_impl_item(&mut self, node: &'ast ImplItem) {
        if !has_cfg_test_attribute(impl_item_attributes(node)) {
            visit::visit_impl_item(self, node);
        }
    }

    fn visit_trait_item(&mut self, node: &'ast TraitItem) {
        if !has_cfg_test_attribute(trait_item_attributes(node)) {
            visit::visit_trait_item(self, node);
        }
    }

    fn visit_stmt(&mut self, node: &'ast Stmt) {
        let attributes: &[Attribute] = match node {
            Stmt::Local(local) => &local.attrs,
            Stmt::Macro(statement) => &statement.attrs,
            Stmt::Expr(expression, _) => expression_attributes(expression),
            Stmt::Item(_) => &[],
        };
        if !has_cfg_test_attribute(attributes) {
            visit::visit_stmt(self, node);
        }
    }

    // `pub(crate)` and `pub(super)` name a visibility, never a dependency.
    fn visit_vis_restricted(&mut self, _: &'ast syn::VisRestricted) {}

    fn visit_path(&mut self, node: &'ast syn::Path) {
        if node.leading_colon.is_none() {
            self.record(
                node.segments
                    .iter()
                    .map(|segment| segment.ident.to_string())
                    .collect(),
            );
        }
        visit::visit_path(self, node);
    }

    fn visit_macro(&mut self, node: &'ast Macro) {
        visit::visit_macro(self, node);
        // A macro body is tokens, often not expressions (`tracing`'s `%value` and `?value` fields,
        // `vec![value; count]`), so every `a::b::c` run in it is read as a path.
        let runs = node
            .parse_body_with(|input: ParseStream| input.step(|cursor| Ok(path_runs(*cursor))))
            .unwrap_or_default();
        for run in runs {
            self.record(run);
        }
    }
}

/// The `ident::ident::…` runs in a token stream, its groups included, and the cursor at its end.
fn path_runs(mut cursor: Cursor) -> (Vec<Vec<String>>, Cursor) {
    let mut runs = Vec::new();
    let mut run = Vec::new();
    let mut colons = 0;
    while !cursor.eof() {
        if let Some((ident, next)) = cursor.ident() {
            if colons != 2 && !run.is_empty() {
                runs.push(std::mem::take(&mut run));
            }
            run.push(ident.to_string());
            colons = 0;
            cursor = next;
            continue;
        }
        if let Some((punct, next)) = cursor.punct()
            && punct.as_char() == ':'
        {
            colons += 1;
            cursor = next;
            continue;
        }
        if !run.is_empty() {
            runs.push(std::mem::take(&mut run));
        }
        colons = 0;
        if let Some((inside, _, _, next)) = cursor.any_group() {
            runs.extend(path_runs(inside).0);
            cursor = next;
        } else if let Some((_, next)) = cursor.token_tree() {
            cursor = next;
        } else {
            break;
        }
    }
    if !run.is_empty() {
        runs.push(run);
    }
    (runs, cursor)
}

fn item_attributes(item: &Item) -> &[Attribute] {
    match item {
        Item::Const(item) => &item.attrs,
        Item::Enum(item) => &item.attrs,
        Item::ExternCrate(item) => &item.attrs,
        Item::Fn(item) => &item.attrs,
        Item::ForeignMod(item) => &item.attrs,
        Item::Impl(item) => &item.attrs,
        Item::Macro(item) => &item.attrs,
        Item::Mod(item) => &item.attrs,
        Item::Static(item) => &item.attrs,
        Item::Struct(item) => &item.attrs,
        Item::Trait(item) => &item.attrs,
        Item::TraitAlias(item) => &item.attrs,
        Item::Type(item) => &item.attrs,
        Item::Union(item) => &item.attrs,
        Item::Use(item) => &item.attrs,
        _ => &[],
    }
}

fn impl_item_attributes(item: &ImplItem) -> &[Attribute] {
    match item {
        ImplItem::Const(item) => &item.attrs,
        ImplItem::Fn(item) => &item.attrs,
        ImplItem::Type(item) => &item.attrs,
        ImplItem::Macro(item) => &item.attrs,
        _ => &[],
    }
}

fn trait_item_attributes(item: &TraitItem) -> &[Attribute] {
    match item {
        TraitItem::Const(item) => &item.attrs,
        TraitItem::Fn(item) => &item.attrs,
        TraitItem::Type(item) => &item.attrs,
        TraitItem::Macro(item) => &item.attrs,
        _ => &[],
    }
}

fn expression_attributes(expression: &Expr) -> &[Attribute] {
    match expression {
        Expr::Assign(inner) => &inner.attrs,
        Expr::Block(inner) => &inner.attrs,
        Expr::Call(inner) => &inner.attrs,
        Expr::ForLoop(inner) => &inner.attrs,
        Expr::If(inner) => &inner.attrs,
        Expr::Loop(inner) => &inner.attrs,
        Expr::Macro(inner) => &inner.attrs,
        Expr::Match(inner) => &inner.attrs,
        Expr::MethodCall(inner) => &inner.attrs,
        Expr::Path(inner) => &inner.attrs,
        Expr::Unsafe(inner) => &inner.attrs,
        Expr::While(inner) => &inner.attrs,
        _ => &[],
    }
}

fn audit_repository() -> Vec<String> {
    let owned = crate_rust_sources();
    let sources = owned
        .iter()
        .map(|(path, source)| (path.as_str(), source.as_str()))
        .collect::<Vec<_>>();
    audit_layering(&sources, LAYER_EXCEPTIONS)
}

mod graph;

#[cfg(test)]
mod tests;
