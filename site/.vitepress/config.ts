import { defineConfig } from 'vitepress';
import typedocSidebar from '../api/typedoc-sidebar.json';

export default defineConfig({
  title: 'loops',
  description:
    'Convergence loops for agent work — iterate, depend, judge, steer. The process is code; done is proven, not claimed.',
  base: '/loops/',
  lastUpdated: true,
  markdown: {
    config(md) {
      // The API reference is generated from source doc comments, which may
      // legitimately contain template-looking text ("{{> name}}"). Render all
      // inline code with v-pre so Vue never interprets it as interpolation.
      md.renderer.rules.code_inline = (tokens, idx) =>
        `<code v-pre>${md.utils.escapeHtml(tokens[idx]!.content)}</code>`;
    },
  },
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'API', link: '/api/', activeMatch: '/api/' },
      {
        text: 'Changelog',
        link: 'https://github.com/jonny981/loops/blob/main/CHANGELOG.md',
      },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Core concepts', link: '/guide/concepts' },
          ],
        },
        {
          text: 'Building',
          items: [
            { text: 'Loops and gates', link: '/guide/loops' },
            { text: 'Graphs', link: '/guide/graphs' },
            { text: 'Memory', link: '/guide/memory' },
            { text: 'Engines', link: '/guide/engines' },
          ],
        },
        {
          text: 'Operating',
          items: [
            { text: 'Steering a running graph', link: '/guide/steering' },
            { text: 'Momentum', link: '/guide/momentum' },
            { text: 'Webhooks and control', link: '/guide/webhooks' },
            { text: 'The CLI', link: '/guide/cli' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API reference',
          link: '/api/',
          items: typedocSidebar,
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/jonny981/loops' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@loops-adk/core' },
    ],
    search: { provider: 'local' },
    outline: [2, 3],
    footer: {
      message: 'Released under the MIT License.',
    },
  },
});
