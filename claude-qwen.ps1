# claude-qwen: Claude Code against local llama.cpp (:8083) via the Anthropic proxy (:8089), default model.
# Meant for spawning as a subagent in a fresh session, e.g.:
#   claude-qwen -p "task..." --dangerously-skip-permissions
# All arguments are passed straight through to claude.
$ErrorActionPreference = 'Stop'
$port = if ($env:CLAUDE_QWEN_PROXY_PORT) { $env:CLAUDE_QWEN_PROXY_PORT } else { '8089' }
$base = "http://127.0.0.1:$port"

# Make sure the Anthropic->OpenAI proxy (anthropic-proxy.js -> llama.cpp on :8083) is up.
function Test-Proxy { try { Invoke-WebRequest -Uri "$base/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; $true } catch { $false } }
if (-not (Test-Proxy)) {
    $env:PROXY_PORT = $port
    Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList ('"' + (Join-Path $PSScriptRoot 'anthropic-proxy.js') + '"')
    1..20 | ForEach-Object { if (-not (Test-Proxy)) { Start-Sleep -Milliseconds 250 } }
    if (-not (Test-Proxy)) { [Console]::Error.WriteLine("claude-qwen: proxy failed to start on $base"); exit 3 }
}

# Default model id from the llama.cpp server (it ignores the name anyway); fall back to a label.
$model = 'qwen'
try {
    $m = (Invoke-RestMethod -Uri "$base/v1/models" -TimeoutSec 5).data | Select-Object -First 1
    if ($m.id) { $model = $m.id }
} catch { [Console]::Error.WriteLine('claude-qwen: warning: llama.cpp server not answering on :8083; start it first') }

$env:ANTHROPIC_BASE_URL = $base
$env:ANTHROPIC_AUTH_TOKEN = 'local'
$env:ANTHROPIC_API_KEY = ''
$env:ANTHROPIC_MODEL = $model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $model
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $model
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $model
$env:ANTHROPIC_SMALL_FAST_MODEL = $model
$env:CLAUDE_CODE_SUBAGENT_MODEL = $model
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = '220000'   # headroom below llama.cpp n_ctx (232000)
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:DISABLE_AUTOUPDATER = '1'

$exe = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
if (-not (Test-Path $exe)) { $exe = 'claude' }
& $exe @args
exit $LASTEXITCODE
