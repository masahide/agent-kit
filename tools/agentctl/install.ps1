# agentctl installer for Windows (Windows PowerShell 5.1 / PowerShell 7)
#
#   irm https://raw.githubusercontent.com/masahide/agent-kit/main/tools/agentctl/install.ps1 | iex
#
# Downloads the binary for this CPU from the latest agentctl-v* GitHub release, checks it against
# checksums.txt, installs it as %USERPROFILE%\.local\bin\agentctl.exe and adds that folder to the
# user PATH. Environment variables:
#   AGENTCTL_VERSION      version to install (e.g. 0.1.0); default: the latest agentctl-v* release
#   AGENTCTL_INSTALL_DIR  where to put agentctl.exe (default %USERPROFILE%\.local\bin)
#   AGENTCTL_REPO         repository to download from (default masahide/agent-kit)
#
# This file is ASCII only so that Windows PowerShell 5.1 reads it the same with or without a BOM.
# `iex` runs in the caller's shell, so errors are thrown instead of calling exit (which would close it).

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest very slow on 5.1
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = if ($env:AGENTCTL_REPO) { $env:AGENTCTL_REPO } else { 'masahide/agent-kit' }
    $installDir = if ($env:AGENTCTL_INSTALL_DIR) { $env:AGENTCTL_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.local\bin' }
    $api = if ($env:AGENTCTL_GITHUB_API) { $env:AGENTCTL_GITHUB_API } else { 'https://api.github.com' }
    $web = if ($env:AGENTCTL_GITHUB_URL) { $env:AGENTCTL_GITHUB_URL } else { 'https://github.com' }

    # 32-bit PowerShell reports x86 in PROCESSOR_ARCHITECTURE; the real CPU is in PROCESSOR_ARCHITEW6432
    $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($cpu) {
        'AMD64' { 'amd64' }
        'ARM64' { 'arm64' }
        default { throw "agentctl install: unsupported CPU $cpu" }
    }

    if ($env:AGENTCTL_VERSION) {
        $tag = 'agentctl-v' + $env:AGENTCTL_VERSION.TrimStart('v')
    } else {
        $releases = Invoke-RestMethod -UseBasicParsing "$api/repos/$repo/releases?per_page=100"
        $tag = ($releases | Where-Object { $_.tag_name -like 'agentctl-v*' } | Select-Object -First 1).tag_name
        if (-not $tag) { throw "agentctl install: no agentctl release found in $repo" }
    }

    $asset = "agentctl-windows-$arch.exe"
    $base = "$web/$repo/releases/download/$tag"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('agentctl-' + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        Write-Host "Downloading $asset ($tag)..."
        Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile (Join-Path $tmp $asset)
        Invoke-WebRequest -UseBasicParsing "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt')

        $want = $null
        foreach ($line in Get-Content (Join-Path $tmp 'checksums.txt')) {
            $parts = $line -split '\s+', 2
            if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $want = $parts[0] }
        }
        if (-not $want) { throw "agentctl install: $asset is not in checksums.txt" }
        $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash
        if ($got -ne $want) { throw "agentctl install: checksum mismatch for $asset" } # -ne ignores case

        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        $exe = Join-Path $installDir 'agentctl.exe'
        Move-Item -Force (Join-Path $tmp $asset) $exe
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
    Write-Host "Installed $(& $exe --version) to $exe"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $dirs = @($userPath -split ';' | Where-Object { $_ })
    if ($dirs -notcontains $installDir) {
        [Environment]::SetEnvironmentVariable('Path', (($dirs + $installDir) -join ';'), 'User')
        $env:Path = "$env:Path;$installDir"
        Write-Host "Added $installDir to your user PATH (new terminals pick it up)."
    }

    Write-Host ''
    Write-Host 'Next: agentctl --json doctor'
    Write-Host 'To send messages to Claude sessions, load the agentctl Mod (plugins/agentctl); see docs/agentctl/usage.md.'
}
