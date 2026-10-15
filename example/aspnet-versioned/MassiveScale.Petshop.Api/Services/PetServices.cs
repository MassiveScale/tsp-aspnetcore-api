using MassiveScale.Petshop.Api.Helpers;
using MassiveScale.Petshop.Api.Models;

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
