import "./common.tsp";
namespace MassiveScale.Petshop.Api;

@doc("Represents an order placed by a customer for one or more pets.")
model Order extends EntityBase {
    @doc("The ID of the customer placing the order.")
    @format("uuid")
    customerId: string;

    @doc("The list of items in the order.")
    @minItems(0)
    items: OrderItem[];

    @doc("The status of the order, e.g. placed, approved, delivered.")
    @visibility(Lifecycle.Read, Lifecycle.Update)
    status?: "placed" | "approved" | "delivered" = "placed";
}

@doc("Represents an individual item in an order, which corresponds to a specific pet being ordered.")
model OrderItem extends EntityBase {
    @doc("The ID of the pet being ordered.")
    @format("uuid")
    petId: string;

    @doc("The quantity of pets being ordered.")
    @minValue(1)
    quantity: int32;

    @doc("The price of the pet at the time of the order.")
    price: decimal;
}
