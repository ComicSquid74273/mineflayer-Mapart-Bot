# EC2 Deploy

Target host in this session:

- `ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com`
- Ubuntu 24.04 LTS

This bot requires:

- Node.js 20.x
- `npm install`
- The repo files
- `auth-cache/` if using Microsoft auth and you want to avoid re-login on the server
- Your working config at `nerv-printer-config/_configs/nerv-printer-config.json`

## 1. Server Setup

SSH to the box:

```bash
ssh -i "comic_key.pem" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com
```

Install Node 20 and basic tools:

```bash
sudo apt update
sudo apt install -y curl git unzip build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Expected Node version: `v20.x`

## 2. Copy The Project

From your Windows machine, copy the repo to the server:

```powershell
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" -r "D:\Projects\mapart-bot" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/
```

If you prefer syncing updates later:

```powershell
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" -r "D:\Projects\mapart-bot\nerv-printer-config" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" -r "D:\Projects\mapart-bot\src" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" "D:\Projects\mapart-bot\package.json" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" "D:\Projects\mapart-bot\package-lock.json" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" "D:\Projects\mapart-bot\index.js" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" "D:\Projects\mapart-bot\nerv-printer.js" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
```

## 3. Copy Auth Cache

If the bot will use Microsoft auth on EC2, also copy `auth-cache/` from your working machine.

```powershell
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" -r "D:\Projects\mapart-bot\auth-cache" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
```

If you do not copy `auth-cache/`, the first server-side login may require fresh authentication.

## 4. Install Dependencies On EC2

On the server:

```bash
cd ~/mapart-bot
npm install
mkdir -p logs finished-maps auth-cache
```

## 5. Dry Run

Test startup without daemonizing first:

```bash
cd ~/mapart-bot
node nerv-printer.js --connection=6b6t --disable-logs
```

Or use the npm script:

```bash
cd ~/mapart-bot
npm run start:nerv:6b6t
```

Logs are written to:

- `~/mapart-bot/logs/nerv-printer.log`

## 6. Run In tmux

Install tmux:

```bash
sudo apt install -y tmux
```

Start the bot in a named session:

```bash
cd ~/mapart-bot
tmux new -s mapart
node nerv-printer.js --connection=6b6t
```

Detach with:

- `Ctrl+b`, then `d`

Reattach with:

```bash
tmux attach -t mapart
```

## 7. Run As A systemd Service

Copy the example service from `docs/nerv-printer.service.example` to `/etc/systemd/system/nerv-printer.service`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable nerv-printer
sudo systemctl start nerv-printer
sudo systemctl status nerv-printer
journalctl -u nerv-printer -f
```

## 8. Update Flow

Typical update flow:

```powershell
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" -r "D:\Projects\mapart-bot\src" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" -r "D:\Projects\mapart-bot\nerv-printer-config" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" "D:\Projects\mapart-bot\package.json" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" "D:\Projects\mapart-bot\package-lock.json" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" "D:\Projects\mapart-bot\index.js" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
scp -i "C:\Users\TRUECLOUD\Downloads\comic_key.pem" "D:\Projects\mapart-bot\nerv-printer.js" ubuntu@ec2-54-83-185-104.compute-1.amazonaws.com:~/mapart-bot/
```

Then on EC2:

```bash
cd ~/mapart-bot
npm install
sudo systemctl restart nerv-printer
```

## 9. Notes

- This repo pins Node to `>=20 <21`.
- If ping is the only issue, EC2 should help, but Microsoft auth and host routing can still dominate connect time.
- If you use `auth-cache/`, keep file permissions private on the server.