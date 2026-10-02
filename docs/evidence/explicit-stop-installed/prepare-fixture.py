"""Stage existing public-API fixtures without copying SDK implementation or overriding resolution."""
import hashlib, json, pathlib, shutil
root = pathlib.Path.cwd()
js = pathlib.Path('/opt/handrail/repos/handrail/handrail-ai-assistant-sdk/handrail-sdk-ai-assistant-js')
flutter = pathlib.Path('/opt/handrail/repos/handrail/handrail-ai-assistant-sdk/handrail-sdk-ai-assistant-flutter')
fixture = root / '.reference-build/installed-stop'
files = ['test/run-agent-stop-postgres.mjs', 'test/agent-durable-stop.test.mjs', 'test/agent-stop-process.mjs',
         *['test/fixtures/agent-cancellation/' + name for name in ['api.mjs', 'database.mjs', 'host.mjs', 'dart/projection.dart']]]
receipts = {}
for name in files:
    source, target = js / name, fixture / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    receipts['js/' + name] = hashlib.sha256(target.read_bytes()).hexdigest()
dart = fixture / 'test/fixtures/agent-cancellation/dart'
(dart / 'test').mkdir(exist_ok=True)
name = 'packages/handrail_ai_client/test/cancellation_reason_test.dart'
shutil.copyfile(flutter / name, dart / 'test/cancellation_reason_test.dart')
receipts['flutter/' + name] = hashlib.sha256((flutter / name).read_bytes()).hexdigest()
(dart / 'pubspec.yaml').write_text('''name: handrail_projection_fixture
publish_to: none
environment:
  sdk: '>=3.4.0 <4.0.0'
dependencies:
  handrail_ai_client:
    git:
      url: https://github.com/c0x65o/handrail-sdk-ai-assistant-flutter.git
      ref: 9e36132de9ecb6bdcb46f622e67588cff1649575
      path: packages/handrail_ai_client
dev_dependencies:
  test: ^1.25.0
''')
(root / 'docs/evidence/explicit-stop-installed/fixture-source-hashes.json').write_text(json.dumps(receipts, indent=2) + '\n')
print('Staged unchanged public-API test fixtures. Agent resolves by normal package self-reference; JS resolves from root node_modules. No nested JS manifest, compiler paths, loader, or dependency override.')
