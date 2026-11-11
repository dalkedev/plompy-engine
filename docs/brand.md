# Brand guide

## Name and positioning

Use **plompy-engine**, lowercase and hyphenated, for the repository and engine. Use **Plompy**
when referring to the assistant in a conversation. Keep `plompy-engine` intact in headings,
links, and portfolio captions.

> A self-hosted personal agent engine with provider-bound CLI sessions and private Markdown memory.

The project is built around continuity: a task starts in a private Discord thread, runs on
the owner's machine, and returns to the same conversation with its context preserved.
Describe the public implementation in concrete terms: one owner, one global worker, a durable
SQLite queue, and explicit recovery. Browser tools are optional.

## Mark and assets

Plompy is a small orange fish with enormous paper-colored eyes and a deadpan expression.
The deliberately silly mascot makes a serious developer tool approachable. The banner's
flowing lines connect the fish to the engine's continuous conversation and retained state.
Use the supplied artwork; preserve its silhouette, face, proportions and palette.

| Asset | Use |
| --- | --- |
| [Logo](../assets/brand/logo.png) | Standalone project mark on a quiet, contrasting background |
| [README banner](../assets/brand/readme-banner.png) | Repository introduction and wide project headers |
| [Social preview](../assets/brand/social-preview.jpg) | Repository link previews and project cards; JPEG export below 1 MB |

Preserve the artwork's proportions. Leave clear space of at least one quarter of the mark's
width around a standalone mark, and check that its eyes remain legible at its displayed size.
Do not stretch, add shadows, or add gradients. A slight rotation is allowed in playful
compositions, as in the supplied banners. Keep text outside the clear space.
Use the banner or preview for wide layouts rather than stretching the square mark.

## Palette

| Color | Hex | Role |
| --- | --- | --- |
| Orange | `#FF6B35` | Project mark and selective emphasis |
| Graphite | `#111315` | Dark backgrounds and text on light surfaces |
| Paper | `#F3F0E8` | Light backgrounds and text on dark surfaces |

Paper on graphite has a contrast ratio of **16.35:1**; orange on graphite is **6.57:1**.
Orange on paper is **2.49:1**, so use graphite for text on paper and reserve orange there for
decoration. Do not rely on color alone to communicate execution state or errors.

## Typography and layout

Use a clear sans serif for project titles and prose, and a monospace face for commands,
identifiers, and state labels. Preserve native Markdown typography in GitHub documentation.
Give diagrams and commands room to breathe; keep essential setup instructions selectable as
text rather than embedding them in an image.

Prefer one strong mark, direct headings, and a restrained orange accent. Screenshots and
examples must use synthetic data. Do not publish a real private conversation as a visual asset.

## Voice

Write plain, specific English. Explain what the engine records, executes, and leaves for the
owner to decide. Lead with the reader's task, then show a command or a link to the relevant guide.

| Prefer | Avoid |
| --- | --- |
| "Resume the saved session for this thread." | "An agent that remembers everything." |
| "Inspect interrupted work before recovery." | "Never lose work again." |
| "Runs on your own Linux machine." | "Fully autonomous, secure by default." |
| "Optional Camoufox tools over local MCP." | "Works with every website." |

Keep claims tied to the public source. Do not imply that local tests establish live model
access, browser authentication, successful publication, or exactly-once external effects.
The source and repository assets are provided under the [MIT license](../LICENSE).

## Source assets

The project artwork was generated with OpenAI image generation for this identity.
The transparent PNG mascot and dark wide README banner are the supplied master files.
The social preview is a separate orange composition, exported at 1200 × 630 pixels.
The mascot, README banner and share card were generated together for the 0.12 identity.

The playful line **Small fish. Your whole machine.** belongs in promotional art.
Use **Your agents. Your machine. Your rules.** for the product's ownership message.
Keep setup, permissions, recovery and error instructions literal rather than jokey.
