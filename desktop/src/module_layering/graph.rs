//! `rust-scc`'s module graph (ADR 0023): one node per production source file's module, an edge to the
//! longest known module prefix of each path the layering reading names, and Tarjan's algorithm over it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use syn::visit::Visit;

use super::{NameVisitor, module_path_of};
use crate::native_command_policy::{TestModuleFiles, rust_sources_in};

/// A module from the crate root, `[]` for the root itself.
pub(super) type ModulePath = Vec<String>;

/// The module graph of `sources` (path relative to the crate manifest, text): each production file's
/// module and the modules it names, never itself.
pub(super) fn module_graph(sources: &[(&str, &str)]) -> BTreeMap<ModulePath, BTreeSet<ModulePath>> {
    let parsed = sources
        .iter()
        .map(|(path, source)| {
            let file = syn::parse_file(source).unwrap_or_else(|error| {
                panic!("failed to parse {path} for the module graph: {error}")
            });
            (*path, file)
        })
        .collect::<Vec<_>>();
    let mut test_modules = TestModuleFiles::default();
    for (path, file) in &parsed {
        test_modules.collect(path, &file.items);
    }
    // `src/main.rs` is the binary crate, whose root would shadow the library's.
    let production = parsed
        .iter()
        .filter(|(path, _)| !test_modules.contains(path) && *path != "src/main.rs")
        .collect::<Vec<_>>();
    let modules = production
        .iter()
        .map(|(path, _)| module_path_of(path))
        .collect::<BTreeSet<_>>();
    let mut graph = BTreeMap::new();
    for (path, file) in production {
        let module = module_path_of(path);
        let mut visitor = NameVisitor {
            module: module.clone(),
            names: BTreeSet::new(),
        };
        visitor.visit_file(file);
        let mut targets = BTreeSet::new();
        for name in visitor.names {
            // A bare path of two or more segments whose first is a child module (`import::start()`
            // in `lidar/mod.rs`); a lone name (`format!`, a local, a field) never names a module.
            let named = name.resolved.or_else(|| {
                let (first, _) = name
                    .segments
                    .split_first()
                    .filter(|(_, rest)| !rest.is_empty())?;
                let child = module.iter().chain([first]).cloned().collect::<Vec<_>>();
                modules
                    .contains(&child)
                    .then(|| module.iter().chain(&name.segments).cloned().collect())
            });
            let target = named.and_then(|named| {
                (0..=named.len())
                    .rev()
                    .map(|length| named[..length].to_vec())
                    .find(|prefix| modules.contains(prefix))
            });
            targets.extend(target.filter(|target| *target != module));
        }
        graph.insert(module, targets);
    }
    graph
}

/// The strongly connected components of two or more modules, each sorted, in module order.
pub(super) fn module_cycles(
    graph: &BTreeMap<ModulePath, BTreeSet<ModulePath>>,
) -> Vec<Vec<ModulePath>> {
    let mut tarjan = Tarjan {
        graph,
        next: 0,
        index: BTreeMap::new(),
        low: BTreeMap::new(),
        stack: Vec::new(),
        on_stack: BTreeSet::new(),
        components: Vec::new(),
    };
    for module in graph.keys() {
        if !tarjan.index.contains_key(module) {
            tarjan.connect(module);
        }
    }
    let mut cycles = tarjan
        .components
        .into_iter()
        .filter(|component| component.len() > 1)
        .map(|mut component| {
            component.sort();
            component
        })
        .collect::<Vec<_>>();
    cycles.sort();
    cycles
}

/// Tarjan's strongly connected components over the module graph (recursive: the crate's module
/// depth bounds it).
struct Tarjan<'a> {
    graph: &'a BTreeMap<ModulePath, BTreeSet<ModulePath>>,
    next: usize,
    index: BTreeMap<&'a ModulePath, usize>,
    low: BTreeMap<&'a ModulePath, usize>,
    stack: Vec<&'a ModulePath>,
    on_stack: BTreeSet<&'a ModulePath>,
    components: Vec<Vec<ModulePath>>,
}

impl<'a> Tarjan<'a> {
    fn connect(&mut self, module: &'a ModulePath) {
        self.index.insert(module, self.next);
        self.low.insert(module, self.next);
        self.next += 1;
        self.stack.push(module);
        self.on_stack.insert(module);
        let graph = self.graph;
        for target in graph.get(module).into_iter().flatten() {
            if !self.index.contains_key(target) {
                self.connect(target);
                let low = self.low[module].min(self.low[target]);
                self.low.insert(module, low);
            } else if self.on_stack.contains(target) {
                let low = self.low[module].min(self.index[target]);
                self.low.insert(module, low);
            }
        }
        if self.low[module] == self.index[module] {
            let mut component = Vec::new();
            while let Some(member) = self.stack.pop() {
                self.on_stack.remove(member);
                component.push(member.clone());
                if member == module {
                    break;
                }
            }
            self.components.push(component);
        }
    }
}

/// A module as the `rust-scc` family keys it: `services::lidar::import`, `crate` for the root.
fn module_key(module: &[String]) -> String {
    if module.is_empty() {
        "crate".to_owned()
    } else {
        module.join("::")
    }
}

/// The `POLICY-SITE` lines for the crate whose manifest directory is `root`, then the end marker.
pub(super) fn module_cycle_report(root: &Path) -> Vec<String> {
    let owned = rust_sources_in(root);
    let sources = owned
        .iter()
        .map(|(path, source)| (path.as_str(), source.as_str()))
        .collect::<Vec<_>>();
    let mut lines = Vec::new();
    for component in module_cycles(&module_graph(&sources)) {
        for module in &component {
            let site = serde_json::json!({ "key": module_key(module), "count": component.len() });
            lines.push(format!("POLICY-SITE {site}"));
        }
    }
    lines.push(format!("POLICY-SITES-END {}", lines.len()));
    lines
}
