import "./common.tsp";

namespace MassiveScale.Petshop.Api;

@doc("Represents a customer of the pet store.")
model Customer extends EntityBase {
    @doc("The first name of the customer.")
    @maxLength(100)
    firstName: string;

    @doc("The last name of the customer.")
    @maxLength(100)
    lastName: string;

    @doc("The email address of the customer.")
    @format("email")
    @maxLength(255)
    email?: string;

    @doc("The phone number of the customer.")
    @format("phone")
    @maxLength(20)
    phoneNumber?: string;
}
