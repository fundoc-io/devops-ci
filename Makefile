CLI_DIR := tools/devops-toolchain-cli
ARTIFACT_DIR ?= dist/artifacts
VERSION ?= $(shell sed -n 's/^[[:space:]]*"version": "\(.*\)",[[:space:]]*$$/\1/p' $(CLI_DIR)/package.json | head -1)
MISE_BINARY ?= resources/mise/mise
CLI_AGENT_TARBALL = $(firstword $(wildcard $(CLI_DIR)/dist/artifacts/devops-ci-agent-linux-x64-*.tar.gz))

.PHONY: help cli-build cli-user-package cli-agent-tarball platform-package dist clean

help:
	@printf '%s\n' \
	  'Targets:' \
	  '  cli-build          Build the TypeScript CLI.' \
	  '  cli-user-package   Build and pack the user npm package.' \
	  '  cli-agent-tarball  Build the Jenkins agent CLI tarball.' \
	  '  platform-package   Package scripts/config/docs for Jenkins nodes.' \
	  '  dist               Build CLI agent tarball and platform package.' \
	  '  clean              Remove generated dist outputs.'

cli-build:
	cd $(CLI_DIR) && pnpm run build

cli-user-package:
	cd $(CLI_DIR) && pnpm run pack:npm

cli-agent-tarball:
	cd $(CLI_DIR) && pnpm run build:agent-tarball

platform-package:
	@args="--version $(VERSION) --output-dir $(ARTIFACT_DIR)"; \
	if [ -n "$(CLI_AGENT_TARBALL)" ]; then \
	  args="$$args --cli-tarball $(CLI_AGENT_TARBALL)"; \
	fi; \
	if [ -f "$(MISE_BINARY)" ]; then \
	  args="$$args --mise-binary $(MISE_BINARY)"; \
	fi; \
		bash scripts/package-devops-ci-platform.sh $$args

dist: cli-agent-tarball platform-package

clean:
	rm -rf dist
	rm -rf $(CLI_DIR)/dist
