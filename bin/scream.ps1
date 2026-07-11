$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
& "node" "$scriptDir\..\apps\scream-code\dist\main.mjs" $args
