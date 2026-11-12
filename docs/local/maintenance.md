# Keep your data when you update

The local image and the private volumes have different lifecycles. Rebuilding or replacing a container should not erase your integrations and results.

## Update from source

Review and obtain the intended source revision. Stop the service, rebuild the chosen target and start it again. Do not run a destructive Git reset in a checkout containing your work.

```sh
docker compose -f compose.local.yaml stop local
docker compose -f compose.local.yaml build local
docker compose -f compose.local.yaml up -d local
docker compose -f compose.local.yaml exec local \
  node scripts/integrations.mjs status --mode local
```

For the browser variant, use `--profile browser` and `local-browser`. Keep the previous source revision available until the updated service passes its connection and artifact checks.

## Back up three things

- Configuration volume: enabled integrations and server settings.
- Secret volume: local token and integration keys, stored in an encrypted private backup.
- Artifact volume: generated files and their provenance.

Stop writes before taking a consistent volume backup. Record the source revision and image used. Do not commit private volume exports to the repository. Test restoration in a separate Compose project before depending on a backup.

## Remove one integration

Use the local CLI's remove command, then restart the gateway. This removes only the selected configuration. Provider-side key revocation is separate. Keep unrelated integrations and artifact files.

## Stop without deleting

```sh
docker compose -f compose.local.yaml down
```

This removes the local containers and network but preserves named volumes. It does not remove the existing Discord engine's separate deployment.

## Uninstall deliberately

Disconnect the `plompy` entry from the host client and remove its local token reference. Back up wanted files, revoke vendor credentials you no longer need, and remove only this deployment's volumes when you intend to erase them.

`docker compose down --volumes` deletes persisted data. It is not a routine update or troubleshooting step.
