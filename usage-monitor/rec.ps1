# Records a task event or a Claude usage reading in the AI Monitor cost model.
#   rec.ps1 -Task <id> -Provider claude|grok|chatgpt -Kind <kind> -Phase start|end
#   rec.ps1 -ClaudeWeekly 63 -ClaudeReset 2026-11-25T02:00:00Z [-Claude5h 21 -Claude5hReset ...]
param(
  [string]$Task, [string]$Provider, [string]$Kind, [ValidateSet('start','end')][string]$Phase,
  [Nullable[double]]$ClaudeWeekly, [string]$ClaudeReset, [Nullable[double]]$Claude5h, [string]$Claude5hReset
)
$uri = 'http://127.0.0.1:43821/record'
function Send-Record($body) {
  Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 5 -Compress) | Out-Null
}
if ($null -ne $ClaudeWeekly) {
  $windows = @(@{ label = '7 days'; used = $ClaudeWeekly; resetsAt = $ClaudeReset })
  if ($null -ne $Claude5h) { $windows += @{ label = '5 hours'; used = $Claude5h; resetsAt = $Claude5hReset } }
  Send-Record @{ type = 'usage'; provider = 'claude'; windows = $windows }
}
if ($Task) { Send-Record @{ type = 'task'; id = $Task; provider = $Provider; kind = $Kind; phase = $Phase } }
'ok'
