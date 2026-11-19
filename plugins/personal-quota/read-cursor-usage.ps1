using namespace System.Windows.Automation

# Windows PowerShell 5.1. Read only the currently displayed Cursor settings page.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Find-VisibleControl($parent, $type, $name) {
    $condition = [AndCondition]::new([Condition[]]@(
        [PropertyCondition]::new([AutomationElement]::ControlTypeProperty, $type)
        [PropertyCondition]::new([AutomationElement]::NameProperty, $name)
        [PropertyCondition]::new([AutomationElement]::IsOffscreenProperty, $false)
    ))
    $matchesFound = $parent.FindAll([TreeScope]::Descendants, $condition)
    if ($matchesFound.Count -ne 1) { throw 'unavailable' }
    $matchesFound[0]
}

function Read-CursorUsage {
    $paths = @(
        "$env:LOCALAPPDATA\Programs\Cursor\Cursor.exe"
        "$env:ProgramFiles\Cursor\Cursor.exe"
    )
    $cursor = @(Get-Process -Name Cursor -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowHandle -ne 0 -and $_.Path -in $paths
    })
    if ($cursor.Count -ne 1) { return }
    $signature = Get-AuthenticodeSignature -LiteralPath $cursor[0].Path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo('SimpleName', $false) -ne 'Anysphere, Inc.') { return }

    $windowFilter = [AndCondition]::new(
        [PropertyCondition]::new([AutomationElement]::ProcessIdProperty, $cursor[0].Id),
        [PropertyCondition]::new([AutomationElement]::ClassNameProperty, 'Chrome_WidgetWin_1')
    )
    $windows = [AutomationElement]::RootElement.FindAll([TreeScope]::Children, $windowFilter)
    if ($windows.Count -ne 1 -or $windows[0].Current.IsOffscreen) { return }
    if ($windows[0].GetCurrentPattern([WindowPattern]::Pattern).Current.WindowVisualState -eq 'Minimized') { return }

    $walker = [TreeWalker]::RawViewWalker
    $heading = Find-VisibleControl $windows[0] ([ControlType]::Text) 'Plan & Usage'
    $panel = $walker.GetParent($walker.GetParent($heading))
    if ($panel.Current.ClassName -notmatch '^ui-scroll-area\b' -or $walker.GetParent($panel).Current.ClassName -notmatch '^agent-panel\b') { return }

    $label = Find-VisibleControl $panel ([ControlType]::Text) 'CURRENT PLAN'
    $card = $walker.GetParent($walker.GetParent($label))
    $bar = Find-VisibleControl $panel ([ControlType]::ProgressBar) 'Weekly usage limit'
    $included = $walker.GetParent($bar)
    if ($card.Current.ClassName -notmatch '^ui-section\b' -or $included.Current.ClassName -notmatch '^ui-section\b') { return }

    # Only inspect text in the verified current-plan card, never the editor or chat.
    $visibleText = [AndCondition]::new(
        [PropertyCondition]::new([AutomationElement]::ControlTypeProperty, [ControlType]::Text),
        [PropertyCondition]::new([AutomationElement]::IsOffscreenProperty, $false)
    )
    $cardText = @($card.FindAll([TreeScope]::Descendants, $visibleText) | ForEach-Object { $_.Current.Name })
    $plans = @($cardText | Where-Object { $_ -cin 'Premium', 'Super', 'Ultra' })
    $resets = @($cardText -clike 'Weekly usage resets on *')
    if ($plans.Count -ne 1 -or $resets.Count -ne 1) { return }
    if ($resets[0] -cnotmatch '^Weekly usage resets on ([^()\r\n]+?)(?: \([^()\r\n]+\))?$') { return }
    $resetText = $Matches[1].Trim()
    if (-not $resetText) { return }

    $null = Find-VisibleControl $included ([ControlType]::Text) "Included in $($plans[0])"
    $null = Find-VisibleControl $included ([ControlType]::Text) 'used'
    $range = $bar.GetCurrentPattern([RangeValuePattern]::Pattern).Current
    if ($range.Minimum -ne 0 -or $range.Maximum -ne 100 -or [double]::IsNaN($range.Value) -or $range.Value -lt 0 -or $range.Value -gt 100) { return }
    [ordered]@{ ok = $true; usedPercent = $range.Value; resetText = $resetText; plan = $plans[0] }
}

try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $result = Read-CursorUsage
} catch {
    # The target can close or switch pages while UI Automation is reading it.
    $result = $null
}
if (-not $result) { $result = @{ ok = $false } }
ConvertTo-Json -InputObject $result -Compress
