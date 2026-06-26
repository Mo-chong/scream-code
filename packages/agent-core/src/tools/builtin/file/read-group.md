Read multiple files in parallel.

Use this when you need to inspect several files in the same step. It performs the same path-access checks and file-type validation as Read, but batches the calls into one tool invocation.

Inputs:
- paths: array of file paths (max 20). Relative paths resolve against the working directory.
- line_offset: optional starting line number (1-based; negative values read from the end).
- n_lines: optional maximum lines per file.

Output:
A single aggregated string grouped by file extension. Each group has a header like `── .ts (3) ──` followed by the files in that group. Within a group, files appear in input order. If a file fails, the error is included inline and the rest continue.

After the file contents, the output may include footers:
- `Skipped missing paths:` when some paths did not exist.
- `Conflict markers detected —` when any file contains unresolved merge conflict markers.
- `Imports:` a cross-file import summary for TypeScript/JavaScript files, showing relative import specifiers (e.g. `a.ts → ./b, ./c`).

Use Read (single file) when only one file is needed; use ReadGroup when you want 2-20 files at once.
