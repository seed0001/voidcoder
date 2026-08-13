# VoidCode Installer — PowerShell + WPF
# Checks prerequisites, installs dependencies, launches the app.
# Requires: PowerShell 5.1+ (built into Windows 10+).

param(
  [switch]$Silent,
  [switch]$LaunchAfter
)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'VoidCode Installer'

# ── paths ──────────────────────────────────────────────────────────────
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeMin = [Version]'20.0.0'

# ── logging ────────────────────────────────────────────────────────────
$Log = @()
function Log($msg, $color = 'White') {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
  $Log += $line
  Write-Host $line -ForegroundColor $color
  if ($Script:LogBox) {
    $Script:LogBox.Dispatcher.Invoke([action]{ $Script:LogBox.AppendText($line + "`n"); $Script:LogBox.ScrollToEnd() }, 'Normal')
  }
}

function LogOK($msg)  { Log "  ✓ $msg" 'Green' }
function LogWarn($msg) { Log "  ⚠ $msg" 'Yellow' }
function LogErr($msg)  { Log "  ✗ $msg" 'Red' }

# ── prerequisites ──────────────────────────────────────────────────────
function Test-NodeInstalled {
  try {
    $v = & node --version 2>$null
    if (-not $v) { return $false, $null }
    $v = $v.TrimStart('v')
    $ver = [Version]$v
    return ($ver -ge $NodeMin), $ver
  } catch { return $false, $null }
}

function Test-NpmInstalled {
  try { $null = & npm --version 2>$null; return $true } catch { return $false }
}

function Install-NodeJS {
  Log 'Node.js not found or too old. Downloading installer...' 'Yellow'
  $url = 'https://nodejs.org/dist/v20.18.3/node-v20.18.3-x64.msi'
  $msi = Join-Path $env:TEMP 'node-v20.18.3-x64.msi'

  try {
    Log "  Downloading Node.js v20.18.3..."
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
    Log "  Downloaded to $msi"

    Log "  Installing Node.js (this may take a minute)..."
    $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
      throw "msiexec exited with code $($proc.ExitCode)"
    }

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')

    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    LogOK 'Node.js installed successfully'
    return $true
  } catch {
    LogErr "Node.js installation failed: $_"
    LogErr "Please install Node.js v20+ manually from https://nodejs.org"
    return $false
  }
}

function Test-GitInstalled {
  try { $null = & git --version 2>$null; return $true } catch { return $false }
}

# ── dependency install ─────────────────────────────────────────────────
function Install-Dependencies {
  Log 'Installing project dependencies (npm install)...'
  Push-Location $RootDir
  try {
    $proc = Start-Process npm -ArgumentList 'install', '--no-audit', '--no-fund', '--loglevel=error' `
      -Wait -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\voidcode-npm-out.txt" `
      -RedirectStandardError "$env:TEMP\voidcode-npm-err.txt"
    if ($proc.ExitCode -ne 0) {
      $errs = Get-Content "$env:TEMP\voidcode-npm-err.txt" -ErrorAction SilentlyContinue
      throw "npm exit code $($proc.ExitCode)`n$($errs -join "`n")"
    }
    LogOK 'Dependencies installed'
    return $true
  } catch {
    LogErr "npm install failed: $_"
    return $false
  } finally {
    Pop-Location
  }
}

# ── launch ─────────────────────────────────────────────────────────────
function Start-VoidCode {
  Log ''
  Log '══ Launching VoidCode desktop app...' 'Cyan'
  Start-Process npm -ArgumentList 'run', 'app' -WorkingDirectory $RootDir
}

# ── WPF GUI ────────────────────────────────────────────────────────────
function Show-InstallerGUI {
  Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

  $xaml = @'
<Window
  xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  Title="VoidCode Installer"
  Width="620" Height="520"
  WindowStartupLocation="CenterScreen"
  ResizeMode="NoResize"
  WindowStyle="None"
  AllowsTransparency="True"
  Background="Transparent">

  <Border CornerRadius="12" Background="#FF0D1117" BorderBrush="#FF30363D" BorderThickness="1">
    <Grid Margin="28,24,28,24">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>

      <!-- Title -->
      <StackPanel Grid.Row="0" Orientation="Horizontal" Margin="0,0,0,12">
        <TextBlock Text="◢◤" FontSize="18" Foreground="#FF58A6FF" FontWeight="Bold"
                   VerticalAlignment="Center" Margin="0,0,10,0"/>
        <TextBlock Text="VoidCode" FontSize="24" FontWeight="Bold" Foreground="#FFE6EDF3"
                   VerticalAlignment="Center"/>
        <TextBlock Text=" installer" FontSize="16" Foreground="#FF8B949E"
                   VerticalAlignment="Bottom" Margin="4,0,0,2"/>
      </StackPanel>

      <!-- Status -->
      <TextBlock Grid.Row="1" x:Name="StatusText" FontSize="13" Foreground="#FF8B949E"
                 TextWrapping="Wrap" Margin="0,0,0,12"
                 Text="Checking prerequisites..."/>

      <!-- Log output -->
      <Border Grid.Row="2" CornerRadius="6" Background="#FF0D1117"
              BorderBrush="#FF21262D" BorderThickness="1" Margin="0,0,0,14">
        <TextBox x:Name="LogBox" FontFamily="Consolas" FontSize="12"
                 Background="Transparent" Foreground="#FFC9D1D9"
                 BorderThickness="0" IsReadOnly="True"
                 VerticalScrollBarVisibility="Auto" TextWrapping="Wrap"
                 AcceptsReturn="True"
                 Padding="10,8"/>
      </Border>

      <!-- Progress + Buttons -->
      <Grid Grid.Row="3">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>

        <ProgressBar x:Name="Progress" Height="6" IsIndeterminate="True"
                     VerticalAlignment="Center" Margin="0,0,16,0"
                     Foreground="#FF58A6FF" Background="#FF21262D"
                     BorderThickness="0"/>

        <StackPanel Grid.Column="1" Orientation="Horizontal">
          <Button x:Name="BtnClose" Content="Cancel" Width="80" Height="32"
                  FontSize="13" Background="#FF21262D" Foreground="#FFC9D1D9"
                  BorderBrush="#FF30363D" BorderThickness="1"
                  Cursor="Hand" Margin="0,0,8,0">
            <Button.Resources>
              <Style TargetType="Border">
                <Setter Property="CornerRadius" Value="6"/>
              </Style>
            </Button.Resources>
          </Button>
          <Button x:Name="BtnLaunch" Content="Launch VoidCode" Width="136" Height="32"
                  FontSize="13" FontWeight="SemiBold"
                  Background="#FF238636" Foreground="White"
                  BorderThickness="0" Cursor="Hand" Visibility="Collapsed">
            <Button.Resources>
              <Style TargetType="Border">
                <Setter Property="CornerRadius" Value="6"/>
              </Style>
            </Button.Resources>
          </Button>
        </StackPanel>
      </Grid>
    </Grid>
  </Border>
</Window>
'@

  $reader = [System.Xml.XmlNodeReader]::new([xml]$xaml)
  $Win = [Windows.Markup.XamlReader]::Load($reader)

  $StatusText = $Win.FindName('StatusText')
  $Script:LogBox = $Win.FindName('LogBox')
  $Progress = $Win.FindName('Progress')
  $BtnClose = $Win.FindName('BtnClose')
  $BtnLaunch = $Win.FindName('BtnLaunch')

  # Allow dragging the borderless window
  $Win.Add_MouseLeftButtonDown({
    param($s, $e) $Win.DragMove()
  })

  $BtnClose.Add_Click({
    $Win.DialogResult = $false
    $Win.Close()
  })

  $BtnLaunch.Add_Click({
    $Win.DialogResult = $true
    $Win.Close()
  })

  # Kick off the install work after the window is shown
  $Win.Add_Loaded({
    $Script:SyncContext = [System.Threading.SynchronizationContext]::Current

    # Run the install sequence on a thread-pool thread so UI stays responsive
    [System.Threading.ThreadPool]::QueueUserWorkItem({
      param($state)
      $sync = $state

      function Invoke-UI($action) {
        $sync.Send([System.Threading.SendOrPostCallback]$action, $null)
      }

      # ── step 1: node check ──
      Invoke-UI { $StatusText.Text = 'Checking for Node.js...' }
      $ok, $ver = Test-NodeInstalled
      if (-not $ok) {
        Log "Node.js >= $NodeMin required. Found: $ver" 'Yellow'
        $installed = Install-NodeJS
        if (-not $installed) {
          Invoke-UI {
            $StatusText.Text = 'Installation failed — Node.js could not be installed.'
            $StatusText.Foreground = '#FFF85149'
            $Progress.Visibility = 'Collapsed'
            $BtnClose.Content = 'Close'
          }
          return
        }
      } else {
        LogOK "Node.js v$ver (≥ $NodeMin)"
      }

      # ── step 2: npm check ──
      if (-not (Test-NpmInstalled)) {
        LogErr 'npm not found — Node.js install may be incomplete.'
        Invoke-UI {
          $StatusText.Text = 'Installation failed — npm not found.'
          $StatusText.Foreground = '#FFF85149'
          $Progress.Visibility = 'Collapsed'
          $BtnClose.Content = 'Close'
        }
        return
      }
      LogOK "npm v$(npm --version)"

      # ── step 3: deps ──
      Invoke-UI { $StatusText.Text = 'Installing dependencies (npm install)...' }
      $depsOk = Install-Dependencies
      if (-not $depsOk) {
        Invoke-UI {
          $StatusText.Text = 'Installation failed — see log for details.'
          $StatusText.Foreground = '#FFF85149'
          $Progress.Visibility = 'Collapsed'
          $BtnClose.Content = 'Close'
        }
        return
      }

      # ── step 4: git check (informational) ──
      if (Test-GitInstalled) {
        LogOK "git v$(& git --version | Select-String -Pattern '\d+\.\d+\.\d+' | % { $_.Matches.Value })"
      } else {
        LogWarn 'Git not found (optional, only needed for git-based tools)'
      }

      # ── done ──
      Invoke-UI {
        $StatusText.Text = 'Installation complete! VoidCode is ready.'
        $StatusText.Foreground = '#FF3FB950'
        $Progress.Visibility = 'Collapsed'
        $BtnClose.Content = 'Close'
        $BtnLaunch.Visibility = 'Visible'
      }
      Log ''
      Log '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' 'Cyan'
      Log '  VoidCode is ready.' 'Cyan'
      Log "  Run 'launch.bat' or 'npm run app' to start." 'Cyan'
      Log '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' 'Cyan'

    }, $Script:SyncContext)
  })

  $result = $Win.ShowDialog()
  return $result
}

# ── silent mode ────────────────────────────────────────────────────────
if ($Silent) {
  Log 'VoidCode Silent Installer' 'Cyan'
  Log '━━━━━━━━━━━━━━━━━━━━━━━━' 'Cyan'

  $ok, $ver = Test-NodeInstalled
  if (-not $ok) {
    LogErr "Node.js >= $NodeMin is required. Found: $ver"
    exit 1
  }
  LogOK "Node.js v$ver"

  if (-not (Test-NpmInstalled)) {
    LogErr 'npm not found.'
    exit 1
  }

  if (-not (Install-Dependencies)) { exit 1 }

  LogOK 'Install complete!'
  if ($LaunchAfter) { Start-VoidCode }
  exit 0
}

# ── GUI mode ───────────────────────────────────────────────────────────
$result = Show-InstallerGUI
if ($result -eq $true) {
  Start-VoidCode
}
