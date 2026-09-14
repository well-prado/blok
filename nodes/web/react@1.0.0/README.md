# @blokjs/react

Renders a pre-compiled React bundle inside an HTML template, with a copy of
`ctx` embedded into the page for the bundle to read back.

> **Deprecated in favour of [`@blokjs/inertia`](../inertia/README.md).** It
> still works and is still published — nothing is being removed — but new UI
> work should use the Inertia SPA layer, and this node will not gain features.
>
> The reason to move is the `ctx` embedding: this node serialises the request
> (headers, cookies, query, body) and the step's inputs into the HTML it sends.
> Inertia sends the props a page **declared**, and nothing else.
>
> The three-step move — declare the page, move the component into a Vite app,
> swap the step — is in
> [docs/d/migration/react-node-to-inertia.mdx](../../../docs/d/migration/react-node-to-inertia.mdx).
> The SPA section starts at [docs/d/spa/index.mdx](../../../docs/d/spa/index.mdx).

## Inputs

| Input | Default | What it is |
| --- | --- | --- |
| `react_app` | — (required) | path to the compiled bundle, relative to this package |
| `index_html` | `index.html` | the EJS template rendered around it |
| `title` | `React App` | `<title>` |
| `metas` / `styles` / `scripts` | `""` | markup injected into the template |
| `root_element` | `root` | id of the mount element |

Output is the rendered HTML string (`contentType: text/html`).
