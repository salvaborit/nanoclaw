# WhatsApp File Sending -- Implementation Plan

**Date:** 2026-02-24
**Status:** Draft
**Research:** [CONTEXT.md](CONTEXT.md)

---

## Design Decisions

Based on the research findings, the following decisions apply to this plan:

1. **Option B -- dedicated `send_file` MCP tool.** Cleaner separation, explicit validation, easier to discover. Small surface area cost is acceptable.
2. **Container path translation via mount map.** The IPC watcher receives the container-internal path (e.g., `/workspace/group/report.pdf`) and translates it to the host path using a static mapping derived from `buildVolumeMounts()`. No "outbox convention" needed -- full mount-aware translation with security validation.
3. **MIME detection via built-in extension map.** No new dependency. A small `EXTENSION_TO_MIME` lookup table covers common types; unknown extensions fall back to `application/octet-stream` (sent as document).
4. **Streaming for large files.** Use `fs.createReadStream()` instead of `fs.readFileSync()` to avoid loading entire files into memory.
5. **File size pre-check.** Validate file size before sending. Reject files exceeding WhatsApp's limits with an informative error logged to the agent.
6. **No file queuing during disconnects.** Text messages are already queued; files are not queued because the file may be modified or deleted between queue time and flush time. File sends during disconnection return an error to the IPC handler.
7. **Host deletes the IPC JSON file after processing (existing behavior).** The source file on disk is NOT deleted -- the agent owns its workspace files.

---

## Implementation Steps

### Step 1: Add MIME type utility and file size constants

**File:** `src/media-utils.ts` (new file)

Create a utility module with:
- `EXTENSION_TO_MIME` map covering: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.mp4`, `.avi`, `.mov`, `.mkv`, `.mp3`, `.ogg`, `.opus`, `.aac`, `.wav`, `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.zip`, `.tar`, `.gz`, `.txt`, `.csv`, `.json`, `.html`.
- `guessMimeType(filePath: string): string` -- looks up extension in map, returns `application/octet-stream` as fallback.
- `classifyMediaType(mime: string): 'image' | 'video' | 'audio' | 'document'` -- maps MIME prefix to Baileys media category.
- `MAX_FILE_SIZES` constant: `{ image: 16_000_000, video: 64_000_000, audio: 16_000_000, document: 100_000_000 }`.
- `validateFileSize(filePath: string, mediaType: string): { ok: boolean; size: number; limit: number }` -- stats the file, compares against limit.

**Acceptance criteria:**
- Module exports all four items.
- `guessMimeType('/foo/bar.pdf')` returns `'application/pdf'`.
- `guessMimeType('/foo/bar.xyz')` returns `'application/octet-stream'`.
- `classifyMediaType('image/png')` returns `'image'`.
- `classifyMediaType('application/pdf')` returns `'document'`.
- `validateFileSize` returns `ok: false` when file exceeds limit.

---

### Step 2: Add `sendFile` to `Channel` interface and `WhatsAppChannel`

**File:** `src/types.ts`

Add to the `Channel` interface:

```typescript
export interface FileMessageOptions {
  fileName?: string;
  mimeType?: string;
  caption?: string;
}

export interface Channel {
  // ... existing members ...
  sendFile?(jid: string, filePath: string, opts: FileMessageOptions): Promise<void>;
}
```

`sendFile` is optional (`?`) so non-WhatsApp channels are not broken.

**File:** `src/channels/whatsapp.ts`

Add a `sendFile()` method to `WhatsAppChannel`:

```typescript
async sendFile(jid: string, filePath: string, opts: FileMessageOptions): Promise<void> {
  if (!this.connected) {
    throw new Error('WhatsApp not connected -- cannot send file');
  }

  const mime = opts.mimeType || guessMimeType(filePath);
  const mediaType = classifyMediaType(mime);
  const sizeCheck = validateFileSize(filePath, mediaType);
  if (!sizeCheck.ok) {
    throw new Error(`File too large: ${sizeCheck.size} bytes exceeds ${mediaType} limit of ${sizeCheck.limit} bytes`);
  }

  const stream = fs.createReadStream(filePath);
  const fileName = opts.fileName || path.basename(filePath);

  let content: Record<string, unknown>;
  switch (mediaType) {
    case 'image':
      content = { image: { stream }, caption: opts.caption };
      break;
    case 'video':
      content = { video: { stream }, caption: opts.caption };
      break;
    case 'audio':
      content = { audio: { stream }, ptt: false };
      break;
    default:  // 'document'
      content = { document: { stream }, mimetype: mime, fileName, caption: opts.caption };
      break;
  }

  await this.sock.sendMessage(jid, content as any);
  logger.info({ jid, filePath: path.basename(filePath), mediaType, size: sizeCheck.size }, 'File sent');
}
```

**Acceptance criteria:**
- `WhatsAppChannel` has a `sendFile` method.
- Method streams the file (no `readFileSync`).
- Method rejects files over the size limit with a descriptive error.
- Method auto-detects MIME type from extension when `mimeType` is not provided.
- Method classifies media type and uses the correct Baileys content shape.
- Audio messages do not include captions (WhatsApp does not support audio captions).

---

### Step 3: Add container path resolution with security validation

**File:** `src/ipc.ts` (add function and extend `IpcDeps`)

Add a `resolveContainerPath()` function that translates container-internal paths to host paths. The function uses a static mount map:

| Container prefix | Host resolution |
|---|---|
| `/workspace/group/` | `groups/{sourceGroup}/` |
| `/workspace/global/` | `groups/global/` |
| `/workspace/project/` | project root (main group only) |
| `/workspace/extra/{name}/` | looked up from group's `additionalMounts` config |

Security requirements:
1. Canonicalize the resolved host path with `path.resolve()`.
2. Verify the canonical path starts with the expected host directory (prevent `../../` traversal).
3. Verify the file exists (`fs.existsSync`).
4. Reject symlinks that point outside the allowed directory (`fs.realpathSync` check).

Extend `IpcDeps`:

```typescript
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile: (jid: string, hostPath: string, opts: { fileName?: string; mimeType?: string; caption?: string }) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // ... rest unchanged ...
}
```

The `resolveContainerPath` function signature:

```typescript
function resolveContainerPath(
  containerPath: string,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
): string | null
```

Returns the validated host path, or `null` if the path is invalid/unauthorized.

**Acceptance criteria:**
- `/workspace/group/report.pdf` resolves to `groups/{folder}/report.pdf` for the correct group.
- `/workspace/group/../../etc/passwd` resolves to `null` (path traversal blocked).
- `/workspace/project/src/index.ts` resolves correctly for main group, returns `null` for non-main groups.
- `/workspace/extra/tasks/file.txt` resolves using the group's `additionalMounts` config.
- Symlink pointing outside allowed directory returns `null`.

---

### Step 4: Handle `file` IPC type in the watcher

**File:** `src/ipc.ts`

In the `processIpcFiles` inner loop, after the existing `data.type === 'message'` block, add handling for `data.type === 'file'`:

```typescript
if (data.type === 'file' && data.chatJid && data.filePath) {
  // Same JID authorization as text messages
  const targetGroup = registeredGroups[data.chatJid];
  if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
    const hostPath = resolveContainerPath(data.filePath, sourceGroup, isMain, registeredGroups);
    if (hostPath) {
      try {
        await deps.sendFile(data.chatJid, hostPath, {
          fileName: data.fileName,
          mimeType: data.mimeType,
          caption: data.caption,
        });
        logger.info({ chatJid: data.chatJid, sourceGroup, file: path.basename(hostPath) }, 'IPC file sent');
      } catch (err) {
        logger.error({ chatJid: data.chatJid, sourceGroup, file: data.filePath, err }, 'Failed to send IPC file');
      }
    } else {
      logger.warn({ filePath: data.filePath, sourceGroup }, 'IPC file path rejected (invalid or unauthorized)');
    }
  } else {
    logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC file attempt blocked');
  }
}
```

**Acceptance criteria:**
- IPC file messages are processed and forwarded to `deps.sendFile`.
- JID authorization is enforced (same rules as text messages).
- Path resolution failure logs a warning and does not send.
- Send errors are caught and logged (file is still deleted from IPC queue).
- Invalid/malformed IPC messages are moved to the errors directory (existing behavior).

---

### Step 5: Wire `sendFile` into `IpcDeps` in `src/index.ts`

**File:** `src/index.ts`

In the `startIpcWatcher({...})` call, add the `sendFile` dependency:

```typescript
startIpcWatcher({
  sendMessage: (jid, text) => {
    const channel = findChannel(channels, jid);
    if (!channel) throw new Error(`No channel for JID: ${jid}`);
    return channel.sendMessage(jid, text);
  },
  sendFile: (jid, hostPath, opts) => {
    const channel = findChannel(channels, jid);
    if (!channel) throw new Error(`No channel for JID: ${jid}`);
    if (!channel.sendFile) throw new Error(`Channel ${channel.name} does not support file sending`);
    return channel.sendFile(jid, hostPath, opts);
  },
  // ... rest unchanged ...
});
```

**Acceptance criteria:**
- `sendFile` dep is wired to the correct channel's `sendFile` method.
- Error is thrown if the channel does not support `sendFile`.
- No other changes to `src/index.ts`.

---

### Step 6: Add `send_file` MCP tool in the container

**File:** `container/agent-runner/src/ipc-mcp-stdio.ts`

Add a new `send_file` tool after the existing `send_message` tool:

```typescript
server.tool(
  'send_file',
  `Send a file (image, document, video, audio) to the user or group via WhatsApp.

The file must already exist at the specified path. Write the file to /workspace/group/ first, then call this tool.

Supported formats:
- Images: JPG, PNG, GIF, WebP (up to ~16 MB)
- Videos: MP4, AVI, MOV (up to ~64 MB)
- Audio: MP3, OGG, WAV (up to ~16 MB)
- Documents: PDF, DOC, XLS, ZIP, or any file type (up to ~100 MB)

Tips:
- Use caption to add context (not supported for audio)
- If mime_type is omitted it will be detected from the file extension
- File name defaults to the basename of the path`,
  {
    file_path: z.string().describe('Absolute path to the file inside the container (e.g., /workspace/group/report.pdf)'),
    file_name: z.string().optional().describe('Display name for the file (e.g., "Q4 Report.pdf"). Defaults to the file basename.'),
    mime_type: z.string().optional().describe('MIME type (e.g., "application/pdf"). Auto-detected from extension if omitted.'),
    caption: z.string().optional().describe('Caption text shown with the file (not supported for audio).'),
  },
  async (args) => {
    // Validate file exists inside the container
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}. Write the file first, then call send_file.` }],
        isError: true,
      };
    }

    const stat = fs.statSync(args.file_path);
    if (!stat.isFile()) {
      return {
        content: [{ type: 'text' as const, text: `Path is not a file: ${args.file_path}` }],
        isError: true,
      };
    }

    writeIpcFile(MESSAGES_DIR, {
      type: 'file',
      chatJid,
      groupFolder,
      filePath: args.file_path,
      fileName: args.file_name || undefined,
      mimeType: args.mime_type || undefined,
      caption: args.caption || undefined,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `File queued for sending: ${path.basename(args.file_path)}` }],
    };
  },
);
```

**Acceptance criteria:**
- Tool is registered with name `send_file`.
- Tool validates the file exists and is a regular file before writing IPC.
- IPC message uses `type: 'file'` with all relevant fields.
- Tool description clearly instructs the agent to write the file first, then call `send_file`.
- Optional fields are omitted from the IPC message when not provided (not written as `null`).

---

### Step 7: Add `routeOutboundFile` helper to router

**File:** `src/router.ts`

Add a helper function for routing file sends, parallel to `routeOutbound`:

```typescript
export function routeOutboundFile(
  channels: Channel[],
  jid: string,
  filePath: string,
  opts: FileMessageOptions,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (!channel.sendFile) throw new Error(`Channel ${channel.name} does not support file sending`);
  return channel.sendFile(jid, filePath, opts);
}
```

This is not strictly required for the IPC path (which goes through `deps.sendFile` directly) but provides a clean API for any future callers that want to send files through the router.

**Acceptance criteria:**
- Function exported from `src/router.ts`.
- Returns a Promise that resolves when the file is sent.
- Throws descriptive errors for missing channel or unsupported channel.

---

## File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/media-utils.ts` | **New** | MIME detection, media classification, file size validation |
| `src/types.ts` | **Modify** | Add `FileMessageOptions` interface; add optional `sendFile` to `Channel` |
| `src/channels/whatsapp.ts` | **Modify** | Add `sendFile()` method to `WhatsAppChannel` |
| `src/ipc.ts` | **Modify** | Add `resolveContainerPath()`, extend `IpcDeps`, handle `type: 'file'` |
| `src/index.ts` | **Modify** | Wire `sendFile` into `IpcDeps` |
| `src/router.ts` | **Modify** | Add `routeOutboundFile()` helper |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | **Modify** | Add `send_file` MCP tool |

No changes needed to: `src/config.ts`, `src/db.ts`, `src/container-runner.ts`, `package.json`.

---

## Security Considerations

1. **Path traversal.** The `resolveContainerPath` function must canonicalize paths and validate they remain within allowed mount boundaries. This is the primary security boundary -- a compromised agent could craft paths like `/workspace/group/../../other-group/secrets`. The function must use `path.resolve()` then verify the prefix.

2. **Symlink escape.** After resolving the path textually, call `fs.realpathSync()` on the result and verify the real path also falls within the allowed directory. This prevents a symlink inside `/workspace/group/` from pointing to `/etc/passwd`.

3. **JID authorization.** Same as text messages: non-main groups can only send to their own registered JID. Already enforced by the existing IPC watcher authorization check.

4. **File size.** Pre-check on the host side prevents sending files that will be rejected by WhatsApp. Without this, the agent would not receive useful feedback on why the send failed.

5. **No new dependencies.** The MIME lookup is a static map -- no supply chain risk from adding a new npm package.

---

## Test Criteria

### Unit tests (vitest)

1. **`src/media-utils.ts`:**
   - `guessMimeType` returns correct MIME for all mapped extensions.
   - `guessMimeType` returns `application/octet-stream` for unknown extensions.
   - `classifyMediaType` correctly classifies all MIME prefixes.
   - `validateFileSize` returns `ok: false` for oversized files, `ok: true` for within-limit files.

2. **`resolveContainerPath`:**
   - Resolves `/workspace/group/file.txt` to `groups/{folder}/file.txt`.
   - Resolves `/workspace/project/file.txt` for main group only.
   - Returns `null` for path traversal attempts (`../`).
   - Returns `null` for paths outside any known mount.
   - Returns `null` for non-main group accessing `/workspace/project/`.

3. **IPC file handler:**
   - Correctly calls `deps.sendFile` with translated host path.
   - Blocks unauthorized JID targets.
   - Handles missing files gracefully (logs warning, does not throw).

### Integration / manual tests

4. **End-to-end happy path:**
   - Agent writes a PDF to `/workspace/group/test.pdf`.
   - Agent calls `send_file` with `file_path: '/workspace/group/test.pdf'`.
   - IPC JSON file appears in `data/ipc/{folder}/messages/`.
   - Host picks up file, resolves path, sends via WhatsApp.
   - File arrives in the WhatsApp group as a document with correct name.

5. **Image with caption:**
   - Agent writes a PNG to `/workspace/group/chart.png`.
   - Agent calls `send_file` with caption `"Monthly metrics"`.
   - Image arrives in WhatsApp with the caption visible.

6. **Rejection cases:**
   - File exceeding size limit: agent gets IPC processed but host logs error and file is not sent.
   - Path traversal attempt: host logs security warning, file is not sent.
   - Non-existent file path: MCP tool returns error to agent before writing IPC.
   - Disconnected WhatsApp: `sendFile` throws, IPC handler logs error.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Baileys v7 RC media upload API differs from documented behavior | Low | High -- files fail to send | Test with actual WhatsApp send early (Step 2). The `{ stream }` form is well-established in Baileys. |
| Large file sends block the IPC polling loop | Medium | Medium -- other IPC messages delayed | Baileys upload is async and streams. The IPC loop already uses `await` for `sendMessage`. If latency is a problem, file sends can be moved to a separate async queue in a follow-up. |
| Agent writes file after calling `send_file` (race condition) | Low | Low -- file not found error | The MCP tool validates file existence before writing IPC. The host also checks `fs.existsSync`. Both checks mitigate this. |
| MIME detection misclassifies a file | Low | Low -- wrong media type in WhatsApp | Agent can override with explicit `mime_type` parameter. Extension map covers common types. |
| WhatsApp rejects files at sizes below our pre-check limits | Low | Low -- send fails with WhatsApp error | Limits are conservative. Actual WhatsApp limits are dynamic per session. If this becomes a problem, catch the Baileys error and log it clearly. |

---

## Out of Scope

- **Inbound file receiving.** Downloading files sent by users into the container is a separate feature.
- **File queuing during disconnects.** Files are not queued. Agent receives an error and can retry.
- **Non-WhatsApp channel support.** `sendFile` is optional on `Channel`. Other channels can add support independently.
- **Thumbnail/preview customization.** Baileys auto-computes thumbnails. No manual control needed initially.
- **Outbox cleanup automation.** Files remain in the agent's workspace. Agents manage their own disk.
