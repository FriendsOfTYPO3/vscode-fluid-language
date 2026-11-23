# Fluid Language Server

While an official VSCode extension is a step in the right direction, it will only bring us so
far: Medium to long term, Fluid needs a language server.

Language servers are processes that run independently of the IDE/editor and provide relevant
information for syntax highlighting, autocompletion and more advanced features. One language
server implementation can also cover multiple IDEs/editors (PHPStorm, VSCode, neovim, …),
which would make maintenance a lot easier.

## Requirements for a Fluid Language Server

On a high level, a future Fluid Language Server should cover the following requirements:

* Support both tag and inline syntax
* Support inline and xmlns namespace imports
* Retain language support for HTML, possibly also embedded CSS and JavaScript

To achieve this, the language server needs a parser/tokenizer that can recognize the following
constructs:

* HTML tags (with possible special handling for `style=""`, `on*` event attributes,
  `<style>` and `<script>`)
* Fluid namespace imports
* Fluid tags
* Fluid inline syntax
* support for partial, invalid templates (e. g. start of document to current cursor with first
  half of ViewHelper name)

Based on that information and the current cursor position of the user, the language server
needs to be able to provide autocomplete and hover documentation for:

* HTML tags and attributes (e. g. according to MDN)
* CSS properties (e. g. according to MDN)
* JavaScript language features (e. g. variables)
* Fluid ViewHelpers and components

"Jump to definition" should also be feasible for ViewHelpers and components.

## Available Data Sources

Both TYPO3 and Fluid now provide the necessary insights via CLI commands to provide autocompletion
and hover documentation via a language server:

* TYPO3 v14.2+ provides its global namespaces via `vendor/bin/typo3 fluid:namespaces --json`, 
  [see changelog](https://docs.typo3.org/permalink/changelog:feature-108846-1770196894);
  Backported in [fluid-companion](https://github.com/s2b/fluid-companion/).
  Already used for "Go to Definition", see `client/src/viewHelpers.ts`. Note that it
  answers which namespaces exist, not where their classes live, which still needs
  Composer's `autoload_psr4.php`.
* TYPO3 v13+ provides available ViewHelpers as XSD schema files via
  `vendor/bin/typo3 fluid:schema:generate`, currently located in `var/transient/`,
  [see changelog](https://docs.typo3.org/permalink/changelog:feature-104114-1719419341)
* TYPO3 v14+ also covers registered Fluid component collections with XSD schema files,
  [see changelog](https://docs.typo3.org/permalink/changelog:feature-109114-1772123512)
* Fluid 4+ provides the stand-alone command `vendor/bin/fluid schema` to cover non-TYPO3 projects
  [see documentation](https://docs.typo3.org/permalink/fluid:xsd-schema)

It would also be feasible to provide an additional console command that skips the XSD format
and provides the full ViewHelper/component schema as JSON, which could then contain more information
and would be easier to interpret by the language server. This could first be implemented in
[fluid-companion](https://github.com/s2b/fluid-companion/) and later be integrated into Fluid
Standalone and TYPO3 Core as CLI commands.

## Challenges

### 1. Parsing Fluid Templates

The current Fluid parser is based on regular expressions and thus isn't able to keep track of
its accurate position within a template. While that is not a huge problem for runtime execution
of Fluid templates, it is a showstopper for a parser used by a language server.

There have been first steps to cover the parser with more tests, which would allow bigger
modifications in that area with higher confidence. There have also been experiments to replace
the regular expressions with a proper tokenizer.

However, even after that change, the parser currently does too much (such as resolving all
ViewHelper classes at parse time), which means in the context of TYPO3 that it depends on
dependency injection, which depending on the used ViewHelpers might even require a proper
database connection, just for template parsing. One solution for this would be to split the
parser into multiple stages, where the first stage would not do any resolving whatsoever. It
might also make sense to be able to provide the parser with the resolved ViewHelper information
(which is basically the data from the XSD schema files), which would make the resolving within
the parser obsolete.

One major challenge is support for partial templates: It wouldn't be helpful if the parser
just throws an exception if `<f:i` is used right before the current cursor position. Instead,
it should be possible to determine that this is a partial ViewHelper, which would then make
autocomplete suggestions possible.

Links:

* [tolerant-php-parser](https://github.com/microsoft/tolerant-php-parser), which demonstrates
  that not every parser is suitable for usage in a language server because they are usually not
  error tolerant.
* [SuperHTML](https://github.com/kristoff-it/superhtml), a templating library which uses a
  parser generated with [tree-sitter](https://tree-sitter.github.io/tree-sitter/)
* [HTML5 Parser in PHP 8.4+](https://www.php.net/manual/de/class.dom-htmldocument.php) and
  [masterminds/html5](https://github.com/Masterminds/html5-php). Problem: Fluid is neither valid
  XML nor valid HTML5 because of inline syntax and partials that not necessarily close all opened
  HTML tags.

### 2. Retaining HTML (+ CSS + JavaScript) support

Once Fluid templates use a custom language server, the built-in language support for HTML
is gone. That includes:

* autocompletion of HTML tags and attributes
* hover documentation of HTML tags and attributes, with links to MDN
* auto-closing of tags
* embedded CSS and JavaScript, each with its own language features
* previews of color values

If the Fluid language server cannot provide these features by itself, there are multiple options:

* [vscode-html-languageservice](https://github.com/microsoft/vscode-html-languageservice) and
  [vscode-css-languageservice](https://github.com/microsoft/vscode-css-languageservice) provide
  the built-in language features for HTML and CSS as JavaScript library, which could be
  called by the Fluid language server at the appropriate places (from PHP to JS?).
* [Request forwarding](https://code.visualstudio.com/api/language-extensions/embedded-languages#request-forwarding-sample)
  can be used to forward requests that should be handled by other available language services

As described in the
[conclusion of that chapter](https://code.visualstudio.com/api/language-extensions/embedded-languages#conclusion),
while request forwarding might look like an easier way, it prevents reusing parts of the
implementation in other editors/IDEs because these features aren't part of the language server.
Also, in practice the forwarding isn't as easy to implement as it seems, which is why the decision
was made in an early version of the extension to stick to the built-in HTML language server instead
of request forwarding, [see commit](https://github.com/FriendsOfTYPO3/vscode-fluid-language/commit/9f5fdf527a7fc187937fd0e6b6dbc7f7f5073c6d).

Because Fluid can also be used in non-HTML files, the language server would also need to support a
separate non-HTML mode.

## Stretch Goals

Once the described challenges are solved and a suitable language server is implemented, there are
more aspects within Fluid where a language server could provide help, for example:

* autocompletion for variables specified with `<f:argument>` or provided through
  `ComponentTemplateResolverInterface::getAdditionalVariables()`
* converting tag to inline syntax and reversed
* "guestimating" layout, partial and section names: Based on a file, this cannot be determined
  reliably, but in the context of TYPO3, the available files can usually be suggested based on
  the folder structure.
* ViewHelper-specific autocomplete in the context of TYPO3, such as language labels or resource
  paths.

## Conclusion

While it's certainly possible and also desirable to have a language server for Fluid that can be
used across editors/IDEs, there are major challenges on the way to achieve that. From my point of
view today, there are two possible ways forwards:

1. Create a separate parser for Fluid, which is optimized for the concrete use case and can deal
   with partial template files. To be able to reuse most of what is already available for HTML,
   CSS and JavaScript, it might even be reasonable to write that Fluid parser in JavaScript.
2. Stabilize existing PHP-based Fluid parser and cover it with more tests. Start rewriting parts
   of it (tokenizer, ViewHelper resolving, see above). Add support for partial templates, maybe
   behind feature flag. Investigate feasibility of HTML parsing in PHP or bundle JavaScript-based
   HTML language library and delegate from PHP implementation to JavaScript implementation when
   necessary.

For me personally, it seems like the second option is the better one, since optimizations in
Fluid's parser not only benefit editor/IDE integration but the Fluid runtime itself and the tooling
around it. Also, having only one parser implementation makes sure that there aren't any
inconsistencies between editors/IDEs and the actual runtime behavior of the template file.
