import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


REPO_ROOT = Path('/home/duxianghe/ModelNet-toc')
SCRIPT = REPO_ROOT / 'scripts/rebuild_modelnet_app_dev.sh'
SOURCE_ROOT = REPO_ROOT / 'modelnet-app'
IMAGE_REF = 'modelnet-toc-dev-app:cycle-fix-20260711'
IMAGE_ID = 'sha256:0123456789abcdef'
COMPOSE_PREFIX = [
    'compose',
    '--project-name',
    'modelnet-toc-dev',
    '--env-file',
    str(REPO_ROOT / '.env'),
    '--env-file',
    str(REPO_ROOT / '.env.dev'),
    '-f',
    str(REPO_ROOT / 'docker-compose.dev.yml'),
]


class RebuildModelnetAppDevTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.temp_path = Path(self.temp_dir.name)
        self.log_path = self.temp_path / 'docker-commands.jsonl'
        fake_docker = self.temp_path / 'docker'
        fake_docker.write_text(
            textwrap.dedent(
                '''\
                #!/usr/bin/env python3
                import json
                import os
                from pathlib import Path
                import sys

                args = sys.argv[1:]
                with Path(os.environ['FAKE_DOCKER_LOG']).open('a') as log:
                    log.write(json.dumps(args) + '\\n')

                if args[-3:] == ['config', '--format', 'json']:
                    print(os.environ['FAKE_DOCKER_CONFIG_JSON'])
                    raise SystemExit(0)
                if args[-2:] == ['build', 'modelnet-app']:
                    raise SystemExit(0)
                if args[:2] == ['image', 'inspect']:
                    print(os.environ['FAKE_DOCKER_IMAGE_ID'])
                    raise SystemExit(0)

                print(f'unexpected docker arguments: {args}', file=sys.stderr)
                raise SystemExit(2)
                ''',
            ),
        )
        fake_docker.chmod(0o755)

    def config(self, *, context=str(SOURCE_ROOT), name='modelnet-toc-dev'):
        return {
            'name': name,
            'services': {
                'modelnet-app': {
                    'build': {'context': context},
                    'image': IMAGE_REF,
                },
            },
        }

    def docker_commands(self):
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text().splitlines()]

    def run_script(self, config=None, **environment):
        if not SCRIPT.exists():
            self.skipTest(f'missing helper: {SCRIPT}')

        env = os.environ.copy()
        env.pop('MODELNET_APP_SRC', None)
        env.update(
            {
                'FAKE_DOCKER_CONFIG_JSON': json.dumps(config or self.config()),
                'FAKE_DOCKER_IMAGE_ID': IMAGE_ID,
                'FAKE_DOCKER_LOG': str(self.log_path),
                'PATH': f'{self.temp_path}{os.pathsep}{env["PATH"]}',
            },
        )
        env.update(environment)
        return subprocess.run(
            [str(SCRIPT)],
            capture_output=True,
            cwd=REPO_ROOT,
            env=env,
            text=True,
        )

    def test_script_exists(self):
        self.assertTrue(SCRIPT.is_file(), f'missing helper: {SCRIPT}')

    def test_rejects_conflicting_source_before_docker(self):
        result = self.run_script(MODELNET_APP_SRC='/tmp/not-modelnet-app')

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([], self.docker_commands())

    def test_rejects_wrong_project_before_build(self):
        result = self.run_script(self.config(name='wrong-project'))

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([COMPOSE_PREFIX + ['config', '--format', 'json']], self.docker_commands())

    def test_rejects_wrong_context_before_build(self):
        result = self.run_script(self.config(context='/tmp/wrong-context'))

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([COMPOSE_PREFIX + ['config', '--format', 'json']], self.docker_commands())

    def test_success_uses_only_the_audited_build_commands(self):
        result = self.run_script()

        self.assertEqual(0, result.returncode, result.stderr)
        commands = self.docker_commands()
        self.assertEqual(
            [
                COMPOSE_PREFIX + ['config', '--format', 'json'],
                COMPOSE_PREFIX + ['build', 'modelnet-app'],
                ['image', 'inspect', IMAGE_REF, '--format', '{{.Id}}'],
            ],
            commands,
        )

        output = result.stdout
        self.assertIn('modelnet-toc-dev', output)
        self.assertIn(str(SOURCE_ROOT), output)
        self.assertIn(IMAGE_REF, output)
        self.assertIn(IMAGE_ID, output)

        script_text = SCRIPT.read_text()
        recorded_text = '\n'.join(' '.join(command) for command in commands)
        for forbidden in ('docker commit', 'sleep infinity', 'sleep 600'):
            self.assertNotIn(forbidden, script_text)
            self.assertNotIn(forbidden, recorded_text)
        self.assertNotIn('docker run', script_text)
        self.assertNotIn('run', (command[0] for command in commands))


if __name__ == '__main__':
    unittest.main()
