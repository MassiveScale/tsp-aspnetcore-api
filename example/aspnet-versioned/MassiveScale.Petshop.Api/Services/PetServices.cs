using MarketOnce.Community.Campaign.Api.Helpers;
using MarketOnce.Community.Campaign.Api.Models;
using MarketOnce.Community.Campaign.Api.Services;

namespace MassiveScale.Petshop.Api.Services
{
    public class PetServices : IPetsService
    {
        public Task<Pet?> CreateAsync(string storeId, Pet body, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task DeleteAsync(string storeId, string petId, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task<IList<Pet>?> ListAsync(string storeId, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task<Pet?> UpdateAsync(string storeId, string petId, MergePatch<Pet> body, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }
    }
}
