const content = `# modelnet gen - Content Generation

Generate text, images, videos, and audio. Alias: \`modelnet generate\`.

## Subcommands

- \`modelnet gen text <prompt> [-m <model>] [-p <provider>] [--stream] [--temperature <t>]\` - Generate text
- \`modelnet gen image <prompt> [-m <model>] [-n <count>] [--width <w>] [--height <h>]\` - Generate image
- \`modelnet gen video <prompt> -m <model> -p <provider> [--aspect-ratio <r>] [--duration <d>] [--resolution <res>]\` - Generate video
- \`modelnet gen tts <text> [-o <output>] [--voice <v>] [--speed <s>]\` - Text-to-speech
- \`modelnet gen asr <audioFile> [--model <m>] [--language <l>]\` - Speech-to-text
- \`modelnet gen status <generationId> <asyncTaskId>\` - Check generation task status
- \`modelnet gen download <generationId> <asyncTaskId> [-o <output>]\` - Wait and download result
- \`modelnet gen list\` - List generation topics

## Tips

- Image/video generation is async; use \`status\` or \`download\` to get results
- \`--stream\` for text generation outputs tokens as they arrive
- \`--pipe\` for text generation outputs only the raw text (no formatting)

## Finding Available Video / Image Models

Before generating, always look up the correct model ID with \`modelnet model list\`:

\`\`\`bash
# List all video models for the lobehub provider
modelnet model list lobehub --type video

# List only enabled video models
modelnet model list lobehub --type video --enabled

# List image generation models
modelnet model list lobehub --type image
\`\`\`

Use the \`id\` field from the output as the \`-m\` argument. Model IDs for video/image are
**not** the same as human-readable display names — always use the exact \`id\` field.

Example:
\`\`\`bash
# ✅ Correct — use the id from modelnet model list
modelnet gen video "a cat riding a skateboard" -p lobehub -m dreamina-seedance-2-0-260128

# ❌ Wrong — guessed slugs will fail with no_valid_channel_error
modelnet gen video "a cat riding a skateboard" -p lobehub -m seedance-2.0
\`\`\`

## ⚠️ asyncTaskId vs generationId

\`gen status\` and \`gen download\` require TWO different IDs:

- \`<generationId>\` — prefixed with \`gen_\`, e.g. \`gen_abc123\`
- \`<asyncTaskId>\` — a UUID printed after \`→ Task\` in the \`gen image\` / \`gen video\` output,
  e.g. \`7ad0eb13-e9a5-4403-8070-1f7fe95b2f95\`

Passing \`gen_xxx\` as \`<asyncTaskId>\` will cause a server error. Always use the UUID.

Example output from \`modelnet gen video\`:
\`\`\`
✓ Video generation started
  Batch ID: gb_xxx
  Generation gen_abc123 → Task 7ad0eb13-e9a5-4403-8070-1f7fe95b2f95
                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ← this is asyncTaskId
\`\`\`

Correct usage:
\`\`\`bash
modelnet gen status gen_abc123 7ad0eb13-e9a5-4403-8070-1f7fe95b2f95
modelnet gen download gen_abc123 7ad0eb13-e9a5-4403-8070-1f7fe95b2f95 -o result.mp4
\`\`\`
`;

export default content;
