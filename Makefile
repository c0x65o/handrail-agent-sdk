DART ?= dart
FLUTTER ?= flutter

.PHONY: setup-flutter check-flutter
.NOTPARALLEL:

setup-flutter:
	npm ci --include=dev
	cd packages/handrail_agent_client && $(DART) pub get
	cd packages/handrail_agent_widgets && $(FLUTTER) pub get

check-flutter:
	npm run build
	cd packages/handrail_agent_client && $(DART) analyze --fatal-infos
	cd packages/handrail_agent_client && $(DART) test --concurrency=1
	cd packages/handrail_agent_widgets && $(FLUTTER) analyze --no-pub --fatal-infos
	cd packages/handrail_agent_widgets && $(FLUTTER) test --no-pub --concurrency=1
