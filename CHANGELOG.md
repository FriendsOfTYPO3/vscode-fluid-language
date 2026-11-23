# Change Log

## 1.1.0

- Go to Definition for ViewHelpers, resolving tag and inline syntax to the
  implementing PHP class. The global namespaces come from
  `typo3 fluid:namespaces --json`, which requires TYPO3 v14.2 or
  EXT:fluid_companion in v12 and v13. Can be turned off with
  `fluid.features.viewHelperDefinitions`
- New command *Fluid: Reload ViewHelper Index*
- Tailwind CSS IntelliSense works in Fluid (HTML) templates, if the Tailwind CSS
  extension is installed
- TYPO3 and Fluid binaries no longer block the editor while they run, e. g. for
  live template analysis in DDEV projects
- New setting `fluid.bin.timeout`: seconds to wait for a binary to answer,
  10 by default
- `fluid.bin.useDdevIfAvailable` is now read from the configuration as documented
- The `f:switch` snippet is now closed with `</f:switch>` instead of `</f:alias>`

## 1.0.0

- Initial release
- Fluid file detection
- Syntax highlighting for Fluid (HTML) and Fluid (Text)
- Code snippets
- Live Template Analysis
- Autocomplete and documentation for ViewHelpers (only built-in, only tag syntax)
