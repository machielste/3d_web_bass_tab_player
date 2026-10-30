# Native folder selection for the loopback app, without uploading its contents.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$songFolderDialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$songFolderDialog.Description = 'Choose a song folder'
$songFolderDialog.ShowNewFolderButton = $false
try {
    $selectedSongFolder = ''
    if ($songFolderDialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $selectedSongFolder = $songFolderDialog.SelectedPath
    }
    @{ path = $selectedSongFolder } | ConvertTo-Json -Compress
}
finally {
    $songFolderDialog.Dispose()
}
