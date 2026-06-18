### Backend or UI release (most common case):

# 1. Publish the artifact — tag is all the repo itself needs
cd ~/personal/agent          # or agent-ui
git tag v0.2.0 && git push origin main v0.2.0
# CI tests (backend) and pushes ghcr.io/…:v0.2.0

# 2. Roll it out — edit versions.json in agent-cli, plain commit to main, no tag
cd ~/personal/agent-cli
#    "backend": "v0.2.0"   (or "ui": …)
git commit -am "chore: backend v0.2.0" && git push

# Note: `agent update` reads versions.json from raw.githubusercontent.com, which
# caches with max-age=300. For up to ~5 min after the push, `agent update` still
# reports "Already up to date" — that's the CDN, not a failed rollout. Wait and retry.

-----

### CLI release (only when CLI code itself changed):

cd ~/personal/agent-cli
# edit versions.json: "cli": "v0.2.0"  ← must match the tag, the workflow fails otherwise
git commit -am "release: cli v0.2.0"
git tag v0.2.0 && git push origin main v0.2.0