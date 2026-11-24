# Releasing mailcore

A release is a tag. CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request; a pushed
tag `v<version>` runs `.github/workflows/release.yml`: the same gate, then the package published to npm (trusted
publishing, no token) and a GitHub release with its tarball.

On an up-to-date `main`:

```sh
npm version patch        # 0.2.0 → 0.2.1: a commit and the tag v0.2.1 (minor, major, or prerelease --preid next)
git push --follow-tags
```

Set up once, on npmjs.com: `@amenophis1er/mailcore` → Settings → Trusted Publisher → GitHub Actions: user
`amenophis1er`, repository `mailcore`, workflow filename `release.yml`, environment name empty, label `release`;
allow `npm publish`, leave `npm dist-tag` off.

If it fails before npm, nothing was published: fix on `main` and move the tag, or cut the next version. If it
fails after npm, re-run the job: it sees the version on npm, skips the publish, and makes the GitHub release.
