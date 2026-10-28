//! Probe (2.1-M212, pinned specta): a struct field's DataType carries serde
//! `flatten` as a runtime attribute and a skipped field with no type.

#[cfg(test)]
mod tests {
    use specta::datatype::{DataType, Fields, RuntimeMeta, RuntimeNestedMeta};

    #[test]
    fn probe_pinned_specta_carries_flatten_and_skip_on_canopi_file_extra() {
        let types = crate::contracts::contract_types();
        let canopi = types
            .into_sorted_iter()
            .find(|ty| ty.name() == "CanopiFile")
            .expect("CanopiFile is exported");
        let DataType::Struct(strukt) = canopi.ty() else {
            panic!("CanopiFile is a struct");
        };
        let Fields::Named(named) = strukt.fields() else {
            panic!("CanopiFile has named fields");
        };
        let (_, extra) = named
            .fields()
            .iter()
            .find(|(name, _)| name == "extra")
            .expect("specta keeps the skipped extra field");
        assert!(extra.ty().is_none(), "a skipped field has no type");
        assert!(extra.attributes().iter().any(|attr| {
            attr.path == "serde"
                && matches!(&attr.kind, RuntimeMeta::List(items) if items.iter().any(|item| {
                    matches!(item, RuntimeNestedMeta::Meta(RuntimeMeta::Path(path)) if path == "flatten")
                }))
        }));
    }
}
