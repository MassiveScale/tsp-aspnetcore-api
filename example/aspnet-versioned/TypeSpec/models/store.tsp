import "./common.tsp";
using Versioning;
namespace MassiveScale.Petshop.Api;

@doc("Represents a store in the pet store API.")
model Store extends EntityBase {
    @doc("The name of the store.")
    @maxLength(100)
    name: string;

    @doc("The phone number of the store.")
    @format("phone")
    phoneNumber: string;

    @doc("The email address of the store.")
    @added(Versions.v2_0)
    @format("email")
    @maxLength(255)
    email: string;

    @doc("The list of pets available in the store.")
    @minItems(0)
    pets: Pet[];
}
