# Change Log

## Unreleased

- Go to Definition for ViewHelpers, resolving tag and inline syntax to the
  implementing PHP class. The global namespaces come from
  `typo3 fluid:namespaces --json`, which requires TYPO3 v14.2 or
  EXT:fluid_companion in v12 and v13
- New command *Fluid: Reload ViewHelper Index*
- `fluid.bin.useDdevIfAvailable` is now read from the configuration as documented

## 1.0.0

- Initial release
- Fluid file detection
- Syntax highlighting for Fluid (HTML) and Fluid (Text)
- Code snippets
- Live Template Analysis
- Autocomplete and documentation for ViewHelpers (only built-in, only tag syntax)
