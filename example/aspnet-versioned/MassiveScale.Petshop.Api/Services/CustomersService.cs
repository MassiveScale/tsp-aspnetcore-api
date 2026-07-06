using MarketOnce.Community.Campaign.Api.Helpers;
using MarketOnce.Community.Campaign.Api.Models;
using MarketOnce.Community.Campaign.Api.Services;

namespace MassiveScale.Petshop.Api.Services
{
    public class CustomersService : ICustomersService
    {
        public Task<Customer?> CreateAsync(Customer body, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task DeleteAsync(string id, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task<IList<Customer>?> ListAsync(CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task<Customer?> ReadAsync(string id, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }

        public Task<Customer?> UpdateAsync(string id, MergePatch<Customer> body, CancellationToken cancellationToken)
        {
            throw new NotImplementedException();
        }
    }
}
