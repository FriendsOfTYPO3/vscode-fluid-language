# VSCode Extension for Fluid Templating Language

This extension for VSCode (and compatible code editors) provides language support
for the [Fluid Templating Engine](https://github.com/TYPO3/Fluid).

<https://github.com/user-attachments/assets/c1808e64-2939-4674-918f-fdfb58d3baf3>

## Installation

The extension is available in the common marketplaces:

* [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=FriendsOfTYPO3.fluid-language)
* [OpenVSX](https://open-vsx.org/extension/FriendsOfTYPO3/fluid-language)

It has been tested with:

* [VSCode](https://code.visualstudio.com/)
* [VSCodium](https://vscodium.com/)
* [Cursor](https://cursor.com/)
* [Windsurf](https://windsurf.com/)

## Features

| Feature                           | Fluid (HTML)    | Fluid (Text)       |
|:----------------------------------|:---------------:|:------------------:|
| Syntax Highlighting               | ✅              | ✅                 |
| Code Snippets                     | ✅              | ✅                 |
| Live Template Analysis            | ✅              | ✅                 |
| HTML Language Features            | ✅              | -                  |
| ViewHelper Autocomplete (tags)    | *only built-in* | -                  |
| ViewHelper Documentation (tags)   | *only built-in* | -                  |
| ViewHelper Autocomplete (inline)  | -               | -                  |
| ViewHelper Documentation (inline) | -               | -                  |
| ViewHelper Go to Definition       | ✅              | ✅                 |

### ViewHelper Go to Definition

*Go to Definition* on a ViewHelper opens the PHP class that implements it, in
tag as well as in inline syntax, and for your own ViewHelpers just as well as
for built-in ones:

```html
<f:link.action action="show" />   <!-- Link/ActionViewHelper.php -->
{title -> f:format.nl2br()}       <!-- Format/Nl2brViewHelper.php -->
<my:teaser record="{record}" />   <!-- your own ViewHelper -->
```

The global ViewHelper namespaces of a project are read from
`typo3 fluid:namespaces --json`, so they are exactly the namespaces that Fluid
itself resolves, including the order in which an extension overrides a core
ViewHelper. That command ships with TYPO3 v14.2 and is backported to v12 and
v13 by the [companion extension](https://extensions.typo3.org/extension/fluid_companion).
The `xmlns:` and `{namespace}` declarations of the template are added on top,
and classes are located through Composer's autoload map.

The binary is looked up exactly like the one for live template analysis, see
below, and is executed once per workspace folder. Use *Fluid: Reload ViewHelper
Index* from the command palette to read the namespaces again, which is needed
after a namespace has been registered by an event listener.

This feature can be turned off with `fluid.features.viewHelperDefinitions`.

### Live Template Analysis

The extension is able to utilize available binaries in your project to provide live
template analysis for Fluid templates, e. g. to detect syntax errors or deprecations.
This works out-of-the-box for Fluid 5.3 (or higher) and TYPO3 14.3 (or higher). In older
TYPO3 versions the
[companion extension](https://extensions.typo3.org/extension/fluid_companion) needs to
be installed.

The following folders are checked for the `fluid` and `typo3` binaries automatically:

* `vendor/bin/`
* `bin/`
* `.Build/bin/`

`typo3` is preferred over `fluid` if both are available.

If [DDEV](https://ddev.com/) is available and the project has DDEV set up, the binaries
are executed inside of the web container by default. This can be turned off by disabling
`fluid.bin.useDdevIfAvailable` in the extension's configuration.

If necessary, custom binaries can also be specified in the extension's configuration via
`fluid.bin.typo3.*` and `fluid.bin.fluid.*`. `${workspaceFolder}` is substituted with the
path of the current workplace folder. Example (execute `fluid` within anonymous docker container):

```json
{
    "fluid.bin.fluid.path": "docker",
    "fluid.bin.fluid.args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "${workspaceFolder}:/app",
        "-w",
        "/app",
        "php:8.5-cli",
        "php",
        "vendor/bin/fluid"
    ]
}
```

### ViewHelper Autocomplete & Documentation

The extension currently doesn't include a dedicated
[language server](https://microsoft.github.io/language-server-protocol/) for Fluid. Instead,
it relies on the built-in HTML language support of VSCode to provide autocompletion and
inline documentation for ViewHelpers. This comes with some limitations:

* only built-in ViewHelpers are supported (no XSD support yet)
* only tag syntax is supported (no inline syntax yet)

The advantage of this approach is that no built-in features for HTML are lost in the process,
this includes highlighting, autocompletion, auto-closing of tags, Emmet, inline documentation,
embedded CSS and JavaScript and previews for color values.

### File Detection

Files matching the following description are considered Fluid HTML files:

* `*.fluid.html` (available since Fluid 5 and TYPO3 14)
* `*.html` files in:
    * `Resources/Private/Templates/`
    * `Resources/Private/Layouts/`
    * `Resources/Private/Partials/`
    * `Resources/Private/Components/`
    * `Resources/Private/PageView/`
    * `ContentBlocks/**/templates/`

Files matching the following description are considered Fluid Text files:

* `*.fluid.*`, excluding `*.fluid.html` (available since Fluid 5 and TYPO3 14)
* `*.txt` files in:
    * `Resources/Private/Templates/`
    * `Resources/Private/Layouts/`
    * `Resources/Private/Partials/`
    * `Resources/Private/Components/`
    * `Resources/Private/PageView/`
    * `ContentBlocks/**/templates/`

## Development & Contribution

We welcome contributions from the community to further improve the developer experience
of Fluid templating in VSCode!

To get started with your local setup, you need `node` and `npm` available in your
development environment. To generate the ViewHelper autocompletion and documentation,
you also need `php` and `composer`.

### General Setup

* clone the project
* run `npm i`
* run `npm run build` or `npm run watch` to transpile TypeScript into JavaScript
* run `npm run lint` to lint your code locally (is also performed in GitHub Actions)
* run `npm run vscode-package` to create a `VSIX` file, which can be installed manually in
  VSCode

For bigger changes, it is advisable to use the
[development and debugging workflow suggested in the official documentation](https://code.visualstudio.com/api/get-started/your-first-extension).

### Generate ViewHelper Autocompletion

The current autocompletion is based on the
[Custom Data format](https://code.visualstudio.com/api/extension-guides/custom-data-extension),
which is read by VSCode's built-in HTML language server.
To generate this file format, a small PHP project installs Fluid Standalone and
all TYPO3 core extensions that expose a global ViewHelper namespace (EXT:fluid, EXT:core
and EXT:form), extracts the ViewHelper API definitions from their source code and writes
the Custom Data json files to `fluid/out/`.

```sh
cd fluid/
composer install
composer generate
```

### Publishing to Marketplace

Publishing is only possible with access to the registered publisher in Visual Studio Code
Marketplace as well as a personal access token with the "manage marketplace" permission.
Details are available in
[publishing extension](https://code.visualstudio.com/api/working-with-extensions/publishing-extension). Same goes for Open VSX, see
[Publishing with the ovsx Command](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions#publishing-with-the-ovsx-command).

Currently, this is done locally:

```sh
git checkout main && git pull
npm version <TODO>
npm run vscode-package
npm exec vsce login friendsoftypo3
npm run vscode-publish
git push --follow-tags
```

Packaging is already setup in GitHub Actions. Once the release workflow is finalized and
properly tested, this can be moved to GitHub Actions as well.

### Language Server Research

During the creation of this extension, research and experiments have been done on the topic
of a dedicated Fluid language server:

[Fluid Language Server](./LanguageServer.md)
