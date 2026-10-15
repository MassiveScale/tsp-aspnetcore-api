using MassiveScale.Petshop.Api.Helpers;
using MassiveScale.Petshop.Api.Models;

namespace MassiveScale.Petshop.Api.Services
{
    public class StoreService : IStoresService
    {
        public Task<Store?> CreateAsync(Store body, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task DeleteAsync(string id, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task<PagedResultStore?> ListAsync(CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task<Store?> ReadAsync(string id, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task UpdateAsync(string id, MergePatch<Store> body, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }
    }
}
