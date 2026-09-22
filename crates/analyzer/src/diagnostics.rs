use crate::model::*;
use rustpython_ast::{Stmt, StmtFunctionDef, StmtAsyncFunctionDef};
use rustpython_parser::source_code::LineIndex;

pub fn check_ast_diagnostics(
    ast: &[Stmt],
    index: &LineIndex,
    diagnostics: &mut Vec<Diagnostic>,
) {
    for stmt in ast {
        check_stmt_diagnostics(stmt, index, diagnostics);
    }
}

fn check_stmt_diagnostics(
    stmt: &Stmt,
    index: &LineIndex,
    diagnostics: &mut Vec<Diagnostic>,
) {
    match stmt {
        Stmt::FunctionDef(fn_def) => {
            check_function_types(fn_def, index, diagnostics);
            for inner in &fn_def.body {
                check_stmt_diagnostics(inner, index, diagnostics);
            }
        }
        Stmt::AsyncFunctionDef(fn_def) => {
            check_async_function_types(fn_def, index, diagnostics);
            for inner in &fn_def.body {
                check_stmt_diagnostics(inner, index, diagnostics);
            }
        }
        Stmt::ClassDef(class_def) => {
            for inner in &class_def.body {
                check_stmt_diagnostics(inner, index, diagnostics);
            }
        }
        _ => {}
    }
}

fn check_function_types(
    func: &StmtFunctionDef,
    index: &LineIndex,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let line = index.line_index(func.range.start()).get() as usize;

    // Check if returns type annotation is missing (except __init__)
    if func.name.as_str() != "__init__" && func.returns.is_none() {
        diagnostics.push(Diagnostic {
            severity: DiagnosticSeverity::Info,
            message: format!("関数 `{}` に戻り値の型アノテーションがありません", func.name),
            line: Some(line),
            rule: Some("ty-type-check".to_string()),
        });
    }

    // Check args annotations
    for arg in &func.args.args {
        if arg.def.annotation.is_none() && arg.def.arg.as_str() != "self" && arg.def.arg.as_str() != "cls" {
            diagnostics.push(Diagnostic {
                severity: DiagnosticSeverity::Info,
                message: format!("引数 `{}` に型アノテーションがありません (関数: {})", arg.def.arg, func.name),
                line: Some(line),
                rule: Some("ty-type-check".to_string()),
            });
        }
    }
}

fn check_async_function_types(
    func: &StmtAsyncFunctionDef,
    index: &LineIndex,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let line = index.line_index(func.range.start()).get() as usize;
    if func.returns.is_none() {
        diagnostics.push(Diagnostic {
            severity: DiagnosticSeverity::Info,
            message: format!("非同期関数 `{}` に戻り値の型アノテーションがありません", func.name),
            line: Some(line),
            rule: Some("ty-type-check".to_string()),
        });
    }
}
