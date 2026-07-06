Set-Location -Path "./TypeSpec"

npm update
tsp compile .

Set-Location -Path ".."

dotnet build MassiveScale.Petshop.slnx