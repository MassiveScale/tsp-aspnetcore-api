using MassiveScale.Petshop.Api.Validators;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.AddControllers();

// The version-aware validators read the API version from the current request.
builder.Services.AddHttpContextAccessor();
builder.Services.AddGeneratedValidators();

var app = builder.Build();
app.MapOpenApi();
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
});
app.UseHttpsRedirection();
app.Run();

