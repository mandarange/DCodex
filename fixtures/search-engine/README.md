# Search engine golden fixtures

Cases covered by `src/core/search/__tests__` and `sks search benchmark`:

- Unicode / Korean text
- Case folding
- CRLF / long line / binary skip
- Hidden / ignored / symlink
- Broken symlink / permission (skipped counts)
- Malformed UTF-8 / regex & glob errors
- TS/JS structure patterns
- Same-name symbols / re-export / alias (symbol confidence)
- Generated / untracked / staged / deleted via git-aware file listing

These fixtures document expected behavior; the live repo is the primary accuracy corpus.
