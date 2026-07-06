using MarketOnce.Community.Campaign.Api.Controllers;
using MarketOnce.Community.Campaign.Api.Helpers;
using MarketOnce.Community.Campaign.Api.Models;
using Microsoft.AspNetCore.Mvc;

namespace MassiveScale.Petshop.Api.Controllers;

public class StoresController : StoresControllerBase
{
    public override Task<IActionResult> Create([FromBody] Store body, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }

    public override Task<IActionResult> Delete([FromRoute] string id, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }

    public override Task<IActionResult> List(CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }

    public override Task<IActionResult> Read([FromRoute] string id, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }

    public override Task<IActionResult> Update([FromRoute] string id, [FromBody] MergePatch<Store> body, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }
}