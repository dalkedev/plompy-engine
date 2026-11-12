# Keep your data when you update

The local image and the private volumes have different lifecycles. Replacing a container should not erase your integrations and results.

## Update a versioned installation

Read the target release notes and download its Local starter kit. Keep a copy of your current Compose files and record the running image digest first. Stop the selected service and take a private backup before replacing the kit files.

Use the new kit in the same deployment directory, preserving your deliberate configuration changes. The kit uses the fixed Compose project name `plompy-local` and named volumes for config, secrets and artifacts. Preserve that name, or your explicit `-p` project name, when updating. Do not run two services against the same volumes and port.

For the current 0.13.0 kit, the core image is pinned to `ghcr.io/dalkedev/plompy-engine:0.13.0-local`. After installing the intended kit:

```sh
docker compose pull local
docker compose up -d local
docker compose exec -T local \
  node scripts/integrations.mjs test --mode local
```

For the browser variant, use `--profile browser` and `local-browser`. If the installation uses the AppArmor override, retain `-f compose.yaml -f compose.apparmor.yaml` for these commands. Reconnect the host client, check status and read an existing artifact before starting new work. Keep the previous kit and image available until those checks pass.

For a development checkout, follow [Build from source](source-build.md) instead of pulling registry images.

## Back up three things

- Configuration volume: enabled integrations and server settings.
- Secret volume: local token and integration keys, stored in an encrypted private backup.
- Artifact volume: generated files and their provenance.

Stop writes before taking a consistent volume backup. Record the release version, image digest and Compose project name. Do not commit private volume exports to a repository. Test restoration in a separate Compose project before depending on a backup.

## Remove one integration

Use the local CLI's remove command, then restart the gateway. This removes only the selected configuration. Provider-side key revocation is separate. Keep unrelated integrations and artifact files.

## Stop without deleting

```sh
docker compose down
```

This removes the local containers and network but preserves named volumes. It does not remove the existing Discord engine's separate deployment.

## Uninstall deliberately

Disconnect the `plompy` entry from the host client and remove its local token reference. Back up wanted files, revoke vendor credentials you no longer need, and remove only this deployment's volumes when you intend to erase them.

`docker compose down --volumes` deletes persisted data. It is not a routine update or troubleshooting step.
