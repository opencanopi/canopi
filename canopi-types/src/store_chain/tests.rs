use super::*;

#[test]
fn admit_version_classifies_every_boundary() {
    let bounded = StoreFloor::from_steps(StoreId::UserDb, 2, 7, Some(10));
    assert_eq!(bounded.current, 9);
    assert_eq!(bounded.step_count(), 7);
    assert_eq!(admit_version(bounded, None), Admission::Absent);
    assert_eq!(
        admit_version(bounded, Some(1)),
        Admission::BeforeFloor {
            version: 1,
            min_readable: 2
        }
    );
    assert_eq!(
        admit_version(bounded, Some(2)),
        Admission::Migratable { from: 2 }
    );
    assert_eq!(admit_version(bounded, Some(9)), Admission::Current);
    assert_eq!(
        admit_version(bounded, Some(10)),
        Admission::NewerReadable { version: 10 }
    );
    assert_eq!(
        admit_version(bounded, Some(11)),
        Admission::RefusedNewer {
            version: 11,
            max_supported: 10
        }
    );

    let unbounded = floor_for(StoreId::UserDb).expect("user_db floor");
    assert_eq!(unbounded.min_readable, 9);
    assert_eq!(unbounded.current, 9);
    assert_eq!(unbounded.max_readable, None);
    assert_eq!(admit_version(unbounded, None), Admission::Absent);
    assert_eq!(
        admit_version(unbounded, Some(8)),
        Admission::BeforeFloor {
            version: 8,
            min_readable: 9
        }
    );
    assert_eq!(admit_version(unbounded, Some(9)), Admission::Current);
    assert_eq!(
        admit_version(unbounded, Some(10)),
        Admission::NewerReadable { version: 10 }
    );
    assert_eq!(
        admit_version(unbounded, Some(999)),
        Admission::NewerReadable { version: 999 }
    );
}

#[test]
fn admit_version_matches_shared_parity_fixture() {
    #[derive(Deserialize)]
    struct ParityCase {
        found: Option<u32>,
        expected: Admission,
    }
    #[derive(Deserialize)]
    struct BoundedFixture {
        store: StoreId,
        min_readable: u32,
        current: u32,
        max_readable: Option<u32>,
        cases: Vec<ParityCase>,
    }
    #[derive(Deserialize)]
    struct StoreCase {
        store: StoreId,
        found: Option<u32>,
        expected: Admission,
    }
    #[derive(Deserialize)]
    struct ParityFixture {
        bounded: BoundedFixture,
        stores: Vec<StoreCase>,
    }

    let fixture: ParityFixture =
        serde_json::from_str(include_str!("../../fixtures/store-chain-parity.json"))
            .expect("store-chain-parity.json must deserialize");
    let bounded = StoreFloor::from_steps(
        fixture.bounded.store,
        fixture.bounded.min_readable,
        fixture.bounded.current - fixture.bounded.min_readable,
        fixture.bounded.max_readable,
    );
    for case in &fixture.bounded.cases {
        assert_eq!(admit_version(bounded, case.found), case.expected);
    }
    for case in &fixture.stores {
        let floor = floor_for(case.store).expect("declared floor");
        assert_eq!(admit_version(floor, case.found), case.expected);
    }
}

#[test]
fn store_floors_are_ordered_and_unique() {
    let mut seen = std::collections::BTreeSet::new();
    for row in STORE_FLOORS {
        assert!(
            seen.insert(row.store),
            "duplicate floor for {:?}",
            row.store
        );
        assert!(row.min_readable <= row.current);
        if let Some(max) = row.max_readable {
            assert!(row.current <= max);
        }
        assert_eq!(floor_for(row.store), Some(*row));
    }
    assert_eq!(floor_for(StoreId::PlantCatalog), None);
}

#[test]
fn form_specs_match_store_floors_and_are_unique() {
    let mut seen_forms = std::collections::BTreeSet::new();
    for spec in FORM_SPECS {
        assert!(
            seen_forms.insert(spec.form),
            "duplicate form {:?}",
            spec.form
        );
        assert_eq!(form_spec(spec.form), spec);
        if let Some(store) = spec.store {
            let floor = floor_for(store).expect("store floor must exist for mapped form");
            assert_eq!(spec.floor, floor.min_readable);
        }
    }
    assert_eq!(FORM_SPECS.len(), 9);
}

#[test]
fn chain_derives_current_validates_steps_and_runs_upgrades() {
    const STEPS: &[Step<Vec<&str>, &'static str>] = &[
        Step {
            from: 1,
            run: |mut log| {
                log.push("1->2");
                Ok(log)
            },
        },
        Step {
            from: 2,
            run: |mut log| {
                log.push("2->3");
                Ok(log)
            },
        },
    ];
    const CHAIN: Chain<'_, Vec<&str>, &'static str> = Chain {
        store: StoreId::Settings,
        floor: 1,
        steps: STEPS,
        reads_newer_up_to: Some(4),
    };
    const _: () = CHAIN.assert_valid();

    assert!(CHAIN.is_valid());
    assert_eq!(CHAIN.current(), 3);
    assert_eq!(CHAIN.store_floor().step_count(), 2);
    assert_eq!(CHAIN.admit(Some(1)), Admission::Migratable { from: 1 });
    assert_eq!(CHAIN.admit(Some(3)), Admission::Current);
    assert_eq!(
        CHAIN.admit(Some(4)),
        Admission::NewerReadable { version: 4 }
    );
    assert_eq!(
        CHAIN.admit(Some(5)),
        Admission::RefusedNewer {
            version: 5,
            max_supported: 4
        }
    );

    assert_eq!(CHAIN.run(None, vec![]), Ok(ChainOutcome::Absent));
    assert_eq!(
        CHAIN.run(Some(0), vec![]),
        Ok(ChainOutcome::BeforeFloor {
            version: 0,
            min_readable: 1
        })
    );
    assert_eq!(
        CHAIN.run(Some(1), vec!["start"]),
        Ok(ChainOutcome::Current {
            version: 3,
            value: vec!["start", "1->2", "2->3"],
            steps_run: 2,
        })
    );
    assert_eq!(
        CHAIN.run(Some(2), vec!["v2"]),
        Ok(ChainOutcome::Current {
            version: 3,
            value: vec!["v2", "2->3"],
            steps_run: 1,
        })
    );
    assert_eq!(
        CHAIN.run(Some(3), vec!["v3"]),
        Ok(ChainOutcome::Current {
            version: 3,
            value: vec!["v3"],
            steps_run: 0,
        })
    );
    assert_eq!(
        CHAIN.run(Some(4), vec!["v4"]),
        Ok(ChainOutcome::NewerReadable {
            version: 4,
            value: vec!["v4"],
        })
    );
    assert_eq!(
        CHAIN.run(Some(5), vec!["v5"]),
        Ok(ChainOutcome::RefusedNewer {
            version: 5,
            max_supported: 4,
        })
    );
}

#[test]
fn chain_reports_step_errors_and_invalid_step_tables() {
    const FAILING: &[Step<u32, &'static str>] = &[
        Step {
            from: 1,
            run: |v| Ok(v + 1),
        },
        Step {
            from: 2,
            run: |_| Err("corrupt-row"),
        },
    ];
    const FAIL_CHAIN: Chain<'_, u32, &'static str> = Chain {
        store: StoreId::Settings,
        floor: 1,
        steps: FAILING,
        reads_newer_up_to: None,
    };
    const _: () = FAIL_CHAIN.assert_valid();
    assert_eq!(
        FAIL_CHAIN.run(Some(1), 0),
        Err(StepError {
            from: 2,
            error: "corrupt-row",
        })
    );

    const BAD_STEPS: &[Step<u32, ()>] = &[Step { from: 2, run: Ok }];
    const BAD_CHAIN: Chain<'_, u32, ()> = Chain {
        store: StoreId::Settings,
        floor: 1,
        steps: BAD_STEPS,
        reads_newer_up_to: None,
    };
    assert!(!BAD_CHAIN.is_valid());
}
