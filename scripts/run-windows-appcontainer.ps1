param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('mechanism', 'stability', 'soak')]
  [string] $Mode,
  [switch] $SelfTestOnly
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runId = [guid]::NewGuid().ToString('N')
$sandboxRoot = Join-Path $env:TEMP "praxis-loop-sandbox-$runId"
$workspace = Join-Path $sandboxRoot 'workspace'
$sandboxEvidence = Join-Path $sandboxRoot 'app-evidence'
$tools = Join-Path $sandboxRoot 'tools'
$executionMode = if ($SelfTestOnly) { 'preflight-only' } else { $Mode }
$evidenceMode = if ($SelfTestOnly) { 'preflight' } else { $Mode }
$externalEvidence = Join-Path $repo (Join-Path 'test-evidence' "windows-$evidenceMode-$runId")
$profileName = "PraxisLoopTest$($runId.Substring(0, 24))"
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$sandboxNodeExe = Join-Path $tools 'node.exe'
$gitExe = (Get-Command git.exe -ErrorAction Stop).Source
$hostSource = Join-Path $PSScriptRoot 'windows-appcontainer-host.cs'

function Assert-UnderTemp([string] $Path) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $tempPath = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
  if ([IO.Path]::GetDirectoryName($fullPath).TrimEnd('\') -ne $tempPath -or
      [IO.Path]::GetFileName($fullPath) -notlike 'praxis-loop-sandbox-*') {
    throw "Refusing to remove an unexpected sandbox path: $fullPath"
  }
  return $fullPath
}

try {
  New-Item -ItemType Directory -Path $workspace, $sandboxEvidence, $tools, $externalEvidence -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo 'dist') -Destination $workspace -Recurse
  Copy-Item -LiteralPath (Join-Path $repo 'tests') -Destination $workspace -Recurse
  New-Item -ItemType Directory -Path (Join-Path $workspace 'scripts') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'evaluate.mjs') -Destination (Join-Path $workspace 'scripts')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-sandbox-selftest.mjs') -Destination (Join-Path $workspace 'scripts')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-tree-selftest.mjs') -Destination (Join-Path $workspace 'scripts')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-test-harness.mjs') -Destination (Join-Path $workspace 'scripts')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-loader-bootstrap.cjs') -Destination (Join-Path $workspace 'scripts')
  Copy-Item -LiteralPath $hostSource -Destination $tools
  Copy-Item -LiteralPath $nodeExe -Destination $sandboxNodeExe
  Copy-Item -LiteralPath (Join-Path $repo 'package.json') -Destination $workspace
  Copy-Item -LiteralPath (Join-Path $repo 'pnpm-lock.yaml') -Destination $workspace

  Add-Type -Path $hostSource
  $hostArgs = [string[]]@('--run', $sandboxRoot, $workspace, $sandboxEvidence, $profileName,
    $sandboxNodeExe, $gitExe, (Join-Path $workspace 'scripts\evaluate.mjs'), $executionMode, $externalEvidence)
  $hostExitCode = [PraxisAppContainerHost]::RunFromPowerShell($hostArgs)

  if (Test-Path -LiteralPath $sandboxEvidence) {
    $runnerEvidence = Join-Path $externalEvidence 'runner-evidence'
    New-Item -ItemType Directory -Path $runnerEvidence -Force | Out-Null
    Get-ChildItem -LiteralPath $sandboxEvidence -Force | Copy-Item -Destination $runnerEvidence -Recurse -Force
  }
  $hostManifestPath = Join-Path $externalEvidence 'host-manifest.json'
  if (Test-Path -LiteralPath $hostManifestPath) {
    $hostManifest = Get-Content -LiteralPath $hostManifestPath -Raw | ConvertFrom-Json
    if ($hostManifest.noNetworkCapabilities -ne $true -or $hostManifest.descendantsClean -ne $true) {
      throw 'Host isolation manifest did not confirm the required AppContainer boundaries.'
    }
  }

  $runnerManifests = @(Get-ChildItem -LiteralPath (Join-Path $externalEvidence 'runner-evidence') -Filter 'manifest.json' -File -Recurse -ErrorAction SilentlyContinue)
  foreach ($manifestFile in $runnerManifests) {
    $manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw | ConvertFrom-Json
    if ($manifest.status -notin @('passed', 'partial')) { throw "Runner manifest did not pass: $($manifestFile.FullName)" }
    $logPath = Join-Path $manifestFile.DirectoryName 'output.log'
    if (-not (Test-Path -LiteralPath $logPath)) { throw "Evidence log is missing for $($manifestFile.FullName)" }
    if ((Get-FileHash -LiteralPath $logPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.logSha256) {
      throw "Evidence log hash does not match the manifest: $logPath"
    }
    if ($manifest.status -eq 'partial') {
      $excluded = @($manifest.testCoverage.excludedTestFiles)
      if ($excluded.Count -gt 0) { Write-Output "Coverage: partial; excluded test files: $($excluded -join ', ')" }
      elseif ($manifest.testCoverage.subprocessCoverageExcluded) { Write-Output "Coverage: partial; $($manifest.testCoverage.subprocessCoverageExcluded)" }
      else { Write-Output 'Coverage: partial; see runner manifest for the scope.' }
    }
  }

  Write-Output "Evidence: $externalEvidence"
  if ($hostExitCode -ne 0) { throw "The $Mode evaluation failed with exit code $hostExitCode. See the host and runner evidence." }
} finally {
  $safeRoot = Assert-UnderTemp $sandboxRoot
  if (Test-Path -LiteralPath $safeRoot) { Remove-Item -LiteralPath $safeRoot -Recurse -Force }
}
