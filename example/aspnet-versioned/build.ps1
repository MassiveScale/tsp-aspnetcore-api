Set-Location -Path (Join-Path $PSScriptRoot "TypeSpec")

npm update
tsp compile .

Set-Location -Path ".."

dotnet build MassiveScale.Petshop.slnx