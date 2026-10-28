// The real module imports `monaco-editor` and its `?worker` entry, which only
// Vite can build. Without it `@monaco-editor/react` loads Monaco from its CDN
// the first time an editor actually opens (files view, diff review), which is
// all the canvas ever needs.
export {};
