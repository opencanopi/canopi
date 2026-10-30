//! What the relaunched Canopi receives after the NSIS update: Canopi's installer command line, read
//! by NSIS `GetOptions` for `/ARGS`, handed by nsis_tauri_utils' `RunAsUser` to the new Canopi as
//! `"<exe>" <value>`, split by Windows into argv. Test code only (the inner attribute below), a
//! module of its own so `launch.rs` keeps under the file-size limit. Ports, as reference models:
//! `GetOptions` from NSIS `Include/FileFunc.nsh` (zlib licence), and the documented
//! `CommandLineToArgvW` rules (2n backslashes and a quote give n and toggle quoting, 2n+1 give n and
//! a literal quote).
#![cfg(test)]

use common_types::update::UpdateBundle;
use std::{ffi::OsString, path::PathBuf};

/// NSIS `${GetOptions} <parameters> <option>`: the text after the option up to the next unquoted
/// option prefix (its first character), trimmed, one pair of matching outer `"`, `'` or `` ` ``
/// removed; `None` when the option is absent. A quote opened by one of the three hides the others
/// and the prefix until it closes. The option name is compared without case, as `StrCmp` does.
fn nsis_get_options(parameters: &str, option: &str) -> Option<String> {
    let (prefix, name) = option.split_at(1);
    let prefix = prefix.chars().next()?;
    let name_len = name.chars().count();
    let mut text: Vec<char> = parameters.chars().collect();
    let mut found = false;
    'begin: loop {
        let mut quote: Option<char> = None;
        let mut at = 0;
        loop {
            let Some(&character) = text.get(at) else {
                if !found {
                    return None;
                }
                break 'begin;
            };
            match (character, quote) {
                ('"' | '\'' | '`', None) => quote = Some(character),
                (character, Some(open)) if character == open => quote = None,
                (_, Some(_)) => {}
                (character, None) if character == prefix && found => {
                    text.truncate(at);
                    break 'begin;
                }
                (character, None) if character == prefix => {
                    // `_trimleft`: the name is compared from the next character on; a miss resumes
                    // the scan after that character, as the NSIS loop does.
                    at += 1;
                    let candidate: String = text.iter().skip(at).take(name_len).collect();
                    if candidate.is_empty() {
                        return None;
                    }
                    if candidate.eq_ignore_ascii_case(name) {
                        text.drain(..at + name_len);
                        while text.first() == Some(&' ') {
                            text.remove(0);
                        }
                        found = true;
                        continue 'begin;
                    }
                }
                _ => {}
            }
            at += 1;
        }
    }
    while text.last() == Some(&' ') {
        text.pop();
    }
    if let (Some(&first), Some(&last)) = (text.first(), text.last())
        && first == last
        && matches!(first, '"' | '\'' | '`')
    {
        text.pop();
        if !text.is_empty() {
            text.remove(0);
        }
    }
    Some(text.into_iter().collect())
}

/// Windows `CommandLineToArgvW`: the program name up to its closing quote (or the first space),
/// then arguments split at unquoted spaces and tabs with the backslash-and-quote rules.
fn command_line_to_argv(command_line: &str) -> Vec<String> {
    let mut chars = command_line.chars().peekable();
    let mut argv = Vec::new();
    let mut program = String::new();
    if chars.peek() == Some(&'"') {
        chars.next();
        program.extend(chars.by_ref().take_while(|&c| c != '"'));
    } else {
        program.extend(chars.by_ref().take_while(|&c| c != ' ' && c != '\t'));
    }
    argv.push(program);
    loop {
        while matches!(chars.peek(), Some(' ' | '\t')) {
            chars.next();
        }
        if chars.peek().is_none() {
            return argv;
        }
        let mut arg = String::new();
        let mut quoted = false;
        while let Some(&character) = chars.peek() {
            match character {
                ' ' | '\t' if !quoted => break,
                '\\' => {
                    let mut backslashes = 0;
                    while chars.peek() == Some(&'\\') {
                        chars.next();
                        backslashes += 1;
                    }
                    if chars.peek() == Some(&'"') {
                        arg.extend(std::iter::repeat_n('\\', backslashes / 2));
                        if backslashes % 2 == 1 {
                            arg.push('"');
                            chars.next();
                        }
                    } else {
                        arg.extend(std::iter::repeat_n('\\', backslashes));
                    }
                }
                '"' => {
                    quoted = !quoted;
                    chars.next();
                }
                _ => {
                    arg.push(character);
                    chars.next();
                }
            }
        }
        argv.push(arg);
    }
}

/// The argv the relaunched Canopi gets after the NSIS installer Canopi starts: Rust's
/// `Command::new(program).raw_arg(parameters)` gives `"<installer>" <parameters>` as `$CMDLINE`,
/// the installer reads `/ARGS` from it, and `RunAsUser` starts `"<exe>" <value>`.
fn relaunched_argv(exe: &str, design: Option<&str>) -> Vec<String> {
    let installer =
        PathBuf::from("C:\\Users\\Jean Pierre\\AppData\\Local\\Temp\\Canopi-update-setup.exe");
    let current = [OsString::from(exe)];
    let command = super::installer_command(
        UpdateBundle::Nsis,
        &installer,
        &super::relaunch_args(&current, design.map(PathBuf::from)),
        None,
    );
    let cmdline = format!(
        "\"{}\" {}",
        command.program.to_string_lossy(),
        command.parameters.to_string_lossy()
    );
    let value = nsis_get_options(&cmdline, "/ARGS").expect("the installer is given /ARGS");
    let mut relaunch = format!("\"{exe}\"");
    if !value.is_empty() {
        relaunch.push(' ');
        relaunch.push_str(&value);
    }
    command_line_to_argv(&relaunch)
}

/// canopi-f47t.52.228.53: NSIS `GetOptions` strips one pair of outer quotes from the `/ARGS` value,
/// so the installer command must keep the Design path whole through that strip: the relaunched
/// Canopi gets the path as one argument, with a space, an apostrophe or a `/` in it, and nothing
/// for a Draft.
#[test]
fn canopi_f47t_52_228_53_the_nsis_relaunch_hands_the_relaunched_canopi_the_design_path_whole() {
    let exe = "C:\\Users\\Jean Pierre\\AppData\\Local\\Canopi\\canopi-desktop.exe";
    let paths = [
        "C:\\My Gardens\\B.canopi",
        "C:\\Gardens\\B.canopi",
        "C:\\Jean's garden.canopi",
        "C:/Gardens/My plot/B.canopi",
    ];
    let relaunched: Vec<Vec<String>> = paths
        .iter()
        .map(|path| relaunched_argv(exe, Some(path)))
        .collect();
    let expected: Vec<Vec<String>> = paths
        .iter()
        .map(|path| vec![exe.to_owned(), (*path).to_owned()])
        .collect();

    assert_eq!(
        (relaunched, relaunched_argv(exe, None)),
        (expected, vec![exe.to_owned()])
    );
}

/// The two ports read as their sources document: `GetOptions` per the NSIS manual's examples, and
/// the Windows argv rules per Microsoft's table.
#[test]
fn the_reference_models_read_as_nsis_and_windows_document() {
    let options = [
        nsis_get_options("/S /D=C:\\Program Files", "/D="),
        nsis_get_options(
            "-INSTDIR=\"C:\\Program Files\\Common Files\" -SILENT=yes",
            "-INSTDIR=",
        ),
        nsis_get_options("/A /B", "/C"),
        nsis_get_options("/ARGS", "/ARGS"),
        nsis_get_options("/args `\"a b\"`", "/ARGS"),
    ];
    let argv = command_line_to_argv("\"C:\\a b\\x.exe\" \"a b\" c\\\\\"d e\" f\\\"g h\\\\i");

    assert_eq!(
        (options, argv),
        (
            [
                Some("C:\\Program Files".to_owned()),
                Some("C:\\Program Files\\Common Files".to_owned()),
                None,
                Some(String::new()),
                Some("\"a b\"".to_owned()),
            ],
            ["C:\\a b\\x.exe", "a b", "c\\d e", "f\"g", "h\\\\i"]
                .map(str::to_owned)
                .to_vec()
        )
    );
}
