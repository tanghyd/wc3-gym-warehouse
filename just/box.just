# The Hetzner box over ssh. BOX_SSH (user@host, in .env or the shell) names it; docs/deploy.md is the runbook.
set working-directory := '..'

ssh := 'ssh "${BOX_SSH:?set BOX_SSH in .env, such as warehouse@203.0.113.7}"'

# set up a fresh Ubuntu 24.04 box as root, such as `just box::bootstrap 203.0.113.7`
bootstrap host:
    scp infrastructure/box/bootstrap.sh root@{{host}}:/root/bootstrap.sh
    ssh root@{{host}} bash /root/bootstrap.sh

# copy .env.box (git-ignored) to the box's .env, readable by the warehouse user only
env:
    @test -f .env.box || { echo '.env.box is missing: cp .env.example .env.box and fill it in (docs/deploy.md)' >&2; exit 1; }
    {{ssh}} 'cat > wc3-gym-warehouse/.env && chmod 600 wc3-gym-warehouse/.env' < .env.box

# check out a pushed branch on the box, then build and start the services of the box's COMPOSE_PROFILES
deploy branch='main':
    {{ssh}} 'cd wc3-gym-warehouse && git fetch -q origin {{branch}} && git checkout -q -B {{branch}} FETCH_HEAD && docker compose up -d --build --remove-orphans'

# one drain pass on the box, then dbt build when it inserted documents
ingest:
    {{ssh}} 'cd wc3-gym-warehouse && just ingest'

# run `just ingest` on the box every 10 minutes, one pass at a time, appending to ~/ingest.log
cron:
    {{ssh}} 'line="*/10 * * * * cd ~/wc3-gym-warehouse && flock -n /tmp/ingest.lock /usr/local/bin/just ingest >> ~/ingest.log 2>&1"; { crontab -l 2>/dev/null | grep -vF "just ingest"; echo "$line"; } | crontab -'

# forward the inspector (3000), Grafana (3001) and dbt's docs (8080) to localhost until Ctrl-C
open:
    {{ssh}} -N -o ExitOnForwardFailure=yes -L 3000:127.0.0.1:3000 -L 3001:127.0.0.1:3001 -L 8080:127.0.0.1:8080

# the containers, the disk, the last ingest passes and the last dbt build's summary
status:
    {{ssh}} 'cd wc3-gym-warehouse && docker compose ps --format "table {{{{.Service}}\t{{{{.Status}}"; df -h /; tail -n 20 ~/ingest.log; grep "Done. PASS=" ~/ingest.log | tail -n 1'
