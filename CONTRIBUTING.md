# Contributing

The protocol is versioned like an API, not like a blog post.

## Pull requests

- One change per PR, with the motivation and, when it touches behaviour, an update to
  `PROTOCOL.md`, the affected `schemas/*.json` and `examples/` together.
- Every PR MUST keep the reference server green: `node examples/reference-server.mjs --selftest`
  prints `SELFTEST OK`.
- New schemas: JSON Schema draft-07, one file per message, with a `description` that states the
  MUST/SHOULD/MAY rules it encodes.

## Versioning

- **v1 evolves additively only**: new optional fields, new optional routes, new enum values in
  server-rendered text. Participants ignore unknown fields, so additions never break a
  conforming client. No version bump needed.
- Anything else — removing or renaming a field, tightening a required constraint, changing
  fail-open behaviour — is **v2**: a new path prefix served side by side with v1 for at least
  one year. Open an issue first; a breaking change needs two independent implementations
  agreeing it is worth it.

## Extensions without breaking v1

- Extra fields go under an `x-` prefix (`x-myvendor-priority`); extra routes go under a vendor
  path (`/<vendor>/…`), never new suffixes colliding with the five protocol routes.
- Core verdict metadata you believe every backend needs: propose it as an *optional* v1 field
  first (servers may ignore it), with at least one implementation using it.

## Code of conduct

Contributor Covenant — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
