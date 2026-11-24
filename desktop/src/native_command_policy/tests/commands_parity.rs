//! Command-table parity test for `canopi_types::commands::ALL_COMMANDS` (Stage 2 B2 / A2).
//! Loaded as a submodule of `native_command_policy::tests` so the `#[tauri::command]` gate runs it.

use super::super::{SYNC_COMMAND_ALLOWLIST, parse_command_registry};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

fn snake_to_camel(snake: &str) -> String {
    let mut out = String::with_capacity(snake.len());
    let mut upper = false;
    for ch in snake.chars() {
        if ch == '_' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn is_tauri_injected_type(ty: &syn::Type) -> bool {
    let syn::Type::Path(path) = ty else {
        return false;
    };
    let Some(last) = path.path.segments.last() else {
        return false;
    };
    matches!(
        last.ident.to_string().as_str(),
        "State" | "AppHandle" | "Window" | "WebviewWindow"
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TypeShape {
    Void,
    String,
    Boolean,
    Number,
    Array(Box<TypeShape>),
    Option(Box<TypeShape>),
    Record,
    Named(String),
}

fn first_generic_type(seg: &syn::PathSegment) -> Option<&syn::Type> {
    let syn::PathArguments::AngleBracketed(args) = &seg.arguments else {
        return None;
    };
    args.args.iter().find_map(|a| match a {
        syn::GenericArgument::Type(t) => Some(t),
        _ => None,
    })
}

fn rust_type_shape(ty: &syn::Type) -> TypeShape {
    match ty {
        syn::Type::Tuple(t) if t.elems.is_empty() => TypeShape::Void,
        syn::Type::Tuple(_) => TypeShape::Array(Box::new(TypeShape::Number)),
        syn::Type::Reference(r) => rust_type_shape(&r.elem),
        syn::Type::Slice(s) => TypeShape::Array(Box::new(rust_type_shape(&s.elem))),
        syn::Type::Array(a) => TypeShape::Array(Box::new(rust_type_shape(&a.elem))),
        syn::Type::Path(p) => {
            let Some(last) = p.path.segments.last() else {
                return TypeShape::Named(String::new());
            };
            let ident = last.ident.to_string();
            match ident.as_str() {
                "String" | "str" | "PathBuf" | "Path" => TypeShape::String,
                "bool" => TypeShape::Boolean,
                "u8" | "u16" | "u32" | "u64" | "usize" | "i8" | "i16" | "i32" | "i64" | "isize"
                | "f32" | "f64" => TypeShape::Number,
                "Option" => {
                    let inner = first_generic_type(last)
                        .map(rust_type_shape)
                        .unwrap_or(TypeShape::Record);
                    TypeShape::Option(Box::new(inner))
                }
                "Vec" => {
                    let inner = first_generic_type(last)
                        .map(rust_type_shape)
                        .unwrap_or(TypeShape::Record);
                    TypeShape::Array(Box::new(inner))
                }
                "HashMap" | "BTreeMap" | "Value" => TypeShape::Record,
                "Channel" => TypeShape::Named("Channel".to_owned()),
                other => TypeShape::Named(other.to_owned()),
            }
        }
        _ => TypeShape::Record,
    }
}

fn rust_reply_shape(output: &syn::ReturnType) -> TypeShape {
    let syn::ReturnType::Type(_, ty) = output else {
        return TypeShape::Void;
    };
    if let syn::Type::Path(p) = ty.as_ref()
        && let Some(last) = p.path.segments.last()
        && last.ident == "Result"
        && let Some(ok_ty) = first_generic_type(last)
    {
        return rust_type_shape(ok_ty);
    }
    rust_type_shape(ty)
}

fn ts_matches_shape(ts: &str, shape: &TypeShape, is_optional_arg: bool) -> bool {
    let ts = ts.trim();
    match shape {
        TypeShape::Void => ts == "void",
        TypeShape::String => {
            ts == "string"
                || ts == "OperationId"
                || ts.contains('\'')
                || ts.contains('"')
                || ts.ends_with("Id")
                || ts.ends_with("Folder")
        }
        TypeShape::Boolean => ts == "boolean",
        TypeShape::Number => ts == "number",
        TypeShape::Option(inner) => {
            if let Some(stripped) = ts.strip_suffix("| null") {
                ts_matches_shape(stripped, inner, false)
            } else if is_optional_arg {
                ts_matches_shape(ts, inner, false)
            } else {
                false
            }
        }
        TypeShape::Array(inner) => {
            if let Some(elem) = ts.strip_suffix("[]") {
                let elem = elem.trim_start_matches("readonly ").trim();
                ts_matches_shape(elem, inner, false)
            } else if ts.starts_with("readonly [") || ts.starts_with('[') {
                true
            } else if let Some(inner_ts) = ts
                .strip_prefix("Array<")
                .or_else(|| ts.strip_prefix("readonly Array<"))
                .and_then(|s| s.strip_suffix('>'))
            {
                ts_matches_shape(inner_ts, inner, false)
            } else {
                false
            }
        }
        TypeShape::Record => ts.starts_with("Record<") || ts == "unknown" || ts.starts_with('{'),
        TypeShape::Named(name) => {
            if ts == name || ts.contains(name.as_str()) {
                return true;
            }
            // Known wire-serialized / TS-aliased structs & newtypes.
            ts != "void" && ts != "boolean" && ts != "number" && ts != "string"
        }
    }
}

struct ParsedHandler {
    args: Vec<(String, TypeShape)>,
    reply: TypeShape,
}

fn parse_command_handlers(commands_dir: &std::path::Path) -> BTreeMap<String, ParsedHandler> {
    let mut handlers: BTreeMap<String, ParsedHandler> = BTreeMap::new();
    for entry in std::fs::read_dir(commands_dir).expect("read desktop/src/commands") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let module = path.file_stem().unwrap().to_str().unwrap().to_owned();
        if module == "mod" {
            continue;
        }
        let src = std::fs::read_to_string(&path).expect("read command module");
        let file = syn::parse_file(&src).expect("parse command module with syn");
        for item in file.items {
            let syn::Item::Fn(func) = item else { continue };
            let is_command = func.attrs.iter().any(|attr| {
                let segs: Vec<_> = attr
                    .path()
                    .segments
                    .iter()
                    .map(|s| s.ident.to_string())
                    .collect();
                segs == ["tauri", "command"] || segs == ["command"]
            });
            if !is_command {
                continue;
            }
            let mut ipc_params = Vec::new();
            for input in &func.sig.inputs {
                let syn::FnArg::Typed(pat_ty) = input else {
                    continue;
                };
                if is_tauri_injected_type(&pat_ty.ty) {
                    continue;
                }
                if let syn::Pat::Ident(pat_ident) = pat_ty.pat.as_ref() {
                    ipc_params.push((
                        snake_to_camel(&pat_ident.ident.to_string()),
                        rust_type_shape(&pat_ty.ty),
                    ));
                }
            }
            let full_path = format!("commands::{module}::{}", func.sig.ident);
            handlers.insert(
                full_path,
                ParsedHandler {
                    args: ipc_params,
                    reply: rust_reply_shape(&func.sig.output),
                },
            );
        }
    }
    handlers
}

#[test]
fn commands_table_matches_tauri_generate_handler_sync_allowlist_and_syn_signatures() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let lib_rs = std::fs::read_to_string(manifest_dir.join("src/lib.rs"))
        .expect("desktop/src/lib.rs must be readable");
    let registered: BTreeSet<String> = parse_command_registry(&lib_rs)
        .expect("generate_handler! must parse")
        .into_iter()
        .collect();
    let declared: BTreeSet<String> = canopi_types::commands::ALL_COMMANDS
        .iter()
        .map(|row| row.path.to_owned())
        .collect();
    assert_eq!(
        declared, registered,
        "canopi_types::commands::ALL_COMMANDS must match tauri::generate_handler! 1-to-1"
    );
    let declared_sync: BTreeSet<&str> = canopi_types::commands::ALL_COMMANDS
        .iter()
        .filter(|row| row.sync == canopi_types::commands::CommandSyncKind::BoundedSync)
        .map(|row| row.path)
        .collect();
    let allowlisted_sync: BTreeSet<&str> = SYNC_COMMAND_ALLOWLIST.iter().map(|a| a.path).collect();
    assert_eq!(
        declared_sync, allowlisted_sync,
        "BoundedSync rows in ALL_COMMANDS must match SYNC_COMMAND_ALLOWLIST"
    );

    let handlers = parse_command_handlers(&manifest_dir.join("src/commands"));

    for row in canopi_types::commands::ALL_COMMANDS {
        let actual = handlers
            .get(row.path)
            .unwrap_or_else(|| panic!("handler {} not found in desktop/src/commands", row.path));
        let expected_names: Vec<String> = row.args.iter().map(|a| a.name.to_owned()).collect();
        let actual_names: Vec<String> = actual.args.iter().map(|(n, _)| n.clone()).collect();
        assert_eq!(
            expected_names, actual_names,
            "IPC arg list mismatch for {} (commands.rs vs syn-parsed Rust handler)",
            row.path
        );
        for (decl, (arg_name, rust_shape)) in row.args.iter().zip(actual.args.iter()) {
            let rust_is_opt = matches!(rust_shape, TypeShape::Option(_));
            if !rust_is_opt {
                assert!(
                    !decl.optional,
                    "arg {}.{} is marked optional in commands.rs but Rust type is {:?}",
                    row.path, arg_name, rust_shape
                );
            }
            assert!(
                ts_matches_shape(decl.ts_type, rust_shape, decl.optional),
                "arg {}.{} TS type '{}' does not match Rust shape {:?}",
                row.path,
                arg_name,
                decl.ts_type,
                rust_shape
            );
        }
        assert!(
            ts_matches_shape(row.reply, &actual.reply, false),
            "reply TS type '{}' for {} does not match Rust return shape {:?}",
            row.reply,
            row.path,
            actual.reply
        );
    }

    // Negative self-check: mismatched primitive arg or reply types are rejected.
    assert!(!ts_matches_shape("number", &TypeShape::String, false));
    assert!(!ts_matches_shape("boolean", &TypeShape::Void, false));
    assert!(!ts_matches_shape(
        "string",
        &TypeShape::Option(Box::new(TypeShape::String)),
        false
    ));
}
