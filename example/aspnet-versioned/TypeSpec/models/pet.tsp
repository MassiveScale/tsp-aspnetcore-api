import "./common.tsp";
using Versioning;
namespace MassiveScale.Petshop.Api;

@doc("Represents the category of a pet, e.g. dog, cat, fish, etc.")
enum PetKind {
    Dog: "dog",
    Cat: "cat",
    Fish: "fish",
    Bird: "bird",
    Reptile: "reptile",
}

@doc("Represents a pet in the pet store.")
@discriminator("$type")
model Pet is EntityBase {
    @doc("The discriminator property for the pet type.")
    @visibility(Lifecycle.Read)
    $type: PetKind;

    @doc("The name of the pet.")
    name: string = "Unnamed Pet";

    @doc("A list of photo URLs for the pet.")
    @maxItems(5)
    photoUrls: string[];

    @doc("A list of tags associated with the pet.")
    @maxItems(10)
    @added(Versions.v2_0)
    tags?: Tag[];

    @doc("The status of the pet in the store, e.g. available, pending, sold.")
    @visibility(Lifecycle.Read, Lifecycle.Update)
    status: "available" | "pending" | "sold" = "available";
}

@doc("Represents a dog in the pet store.")
model Dog extends Pet {
    @doc("The discriminator property for the pet type.")
    @visibility(Lifecycle.Read)
    $type: PetKind.Dog;

    @doc("Indicates whether the dog barks.")
    isBarker: boolean;
}

@doc("Represents a cat in the pet store.")
model Cat extends Pet {
    @doc("The discriminator property for the pet type.")
    @visibility(Lifecycle.Read)
    $type: PetKind.Cat;

    @doc("Indicates whether the cat purrs.")
    isPurrer: boolean;
}

model Tag {
    @doc("The unique identifier of the tag.")
    @visibility(Lifecycle.Read, Lifecycle.Create)
    id: int64;

    @doc("The name of the tag.")
    @visibility(Lifecycle.Read, Lifecycle.Create, Lifecycle.Update)
    name: string;
}

@doc("Represents a paginated list of pets.")
union PetCategory {
    @doc("A domesticated carnivorous mammal that typically has a long snout, an acute sense of smell, and a barking, howling, or whining voice.")
    Dog: "dog",

    @doc("A small domesticated carnivorous mammal with soft fur, a short snout, and retractable claws.")
    Cat: "cat",

    @doc("A small domesticated rodent that typically has a pointed snout, relatively large ears and eyes, and a long tail.")
    Fish: "fish",

    @doc("A warm-blooded egg-laying vertebrate animal distinguished by the possession of feathers, wings, and a beak and (typically) by being able to fly.")
    Bird: "bird",

    @doc("A reptile is a cold-blooded, air-breathing vertebrate that has scales or scutes and typically lays soft-shelled eggs on land.")
    Reptile: "reptile",
}
