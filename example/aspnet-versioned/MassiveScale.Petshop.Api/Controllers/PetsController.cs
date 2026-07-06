using MarketOnce.Community.Campaign.Api.Controllers;
using MarketOnce.Community.Campaign.Api.Helpers;
using MarketOnce.Community.Campaign.Api.Models;
using Microsoft.AspNetCore.Mvc;

namespace MassiveScale.Petshop.Api.Controllers;

public class PetsController : PetsControllerBase
{
    public override Task<IActionResult> Create([FromRoute] string storeId, [FromBody] Pet body, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }

    public override Task<IActionResult> Delete([FromRoute] string storeId, [FromRoute] string petId, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }

    public override Task<IActionResult> List([FromRoute] string storeId, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }

    public override Task<IActionResult> Update([FromRoute] string storeId, [FromRoute] string petId, [FromBody] MergePatch<Pet> body, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }
}