# Results you can inspect

The local artifact tools store files in the dedicated artifact volume. Use JSON for structured evidence, CSV for a spreadsheet, and Markdown for a readable summary or drafts.

## Export a result

Ask your host agent to use `artifacts_export` with a descriptive basename and the matching format. CSV and JSON accept structured records. Markdown accepts text content.

```text
Save the sourced company records as companies.json and companies.csv.
Save the draft messages and any unresolved gaps as drafts.md.
Use the artifact tools, not arbitrary shell writes.
```

## File rules

Names are flat basenames inside the configured artifact directory. Traversal paths and symlink targets are rejected. The tool does not overwrite an unrelated file. Repeating an identical export can return the existing result; changing the content requires a new name.

Exports are bounded. Split a large result into explicit batches instead of asking the model to bypass limits. The response includes a file name, size and content hash so you can identify the output.

## CSV handling

CSV values that could be interpreted as spreadsheet formulas are escaped. This protects exported text such as a company name beginning with `=`. Normal CSV quoting alone does not provide that protection.

Keep source URLs and evidence status in the export. Do not include credentials, session cookies or private account contents.

## List and read

Use `artifacts_list` to discover saved files and `artifacts_read` to inspect a file. Readback checks that the intended result exists; a tool's queue receipt is not a completed file export.

## Retrieve files on the host

The files remain in a Docker volume until you copy them out. From your host, create a new private directory and copy only the artifact directory:

```sh
mkdir -m 700 plompy-results
docker compose cp \
  local:/var/lib/plompy-local/artifacts/. ./plompy-results/
```

Use `local-browser` if that is the running service. Choose a new destination instead of overwriting an existing result directory. Do not mount your entire home directory to make retrieval easier.

For backups and cleanup, see [Updates, backup and uninstall](maintenance.md).
