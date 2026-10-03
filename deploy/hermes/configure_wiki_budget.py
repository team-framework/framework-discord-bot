"""Install the opt-in Wiki budget plugin without modifying Hermes core or secrets."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import shutil
import yaml

NAME = 'framework-wiki-budget'

def configure(home):
    path = home / 'config.yaml'
    config = yaml.safe_load(path.read_text())
    plugins = config.setdefault('plugins', {})
    if not isinstance(plugins, dict): raise ValueError('Review existing plugins settings')
    enabled = plugins.get('enabled', [])
    disabled = plugins.get('disabled', [])
    if not isinstance(enabled,list) or not isinstance(disabled,list): raise ValueError('Review plugin allow-list')
    plugins['enabled'] = list(dict.fromkeys([*enabled, NAME]))
    if NAME in disabled: plugins['disabled'] = [name for name in disabled if name != NAME]
    backup = home/'backups'/('wiki-budget-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(parents=True,mode=0o700)
    shutil.copyfile(path,backup/'config.yaml');(backup/'config.yaml').chmod(0o600)
    destination = home/'plugins'/NAME
    if destination.exists(): shutil.copytree(destination,backup/NAME)
    source=Path(__file__).with_name(NAME)
    destination.mkdir(parents=True,exist_ok=True)
    for name in ['plugin.yaml','__init__.py']:
        temporary=destination/(name+'.tmp');temporary.write_bytes((source/name).read_bytes());temporary.replace(destination/name)
    temporary=path.with_name('config.yaml.wiki-budget-tmp')
    temporary.write_text(yaml.safe_dump(config,allow_unicode=True,sort_keys=False));temporary.chmod(0o600);temporary.replace(path)
    return backup

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--hermes-home',type=Path,default=Path('/home/chaeyn/.hermes'))
    print('Wiki budget plugin installed; private backup:',configure(parser.parse_args().hermes_home))
