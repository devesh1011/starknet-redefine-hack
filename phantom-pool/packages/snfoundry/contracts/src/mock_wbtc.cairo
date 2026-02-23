#[starknet::contract]
pub mod MockWBTC {
    use starknet::ContractAddress;
    use starknet::get_caller_address;
    use starknet::contract_address_const;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess,
        StoragePointerReadAccess, StoragePointerWriteAccess
    };

    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,
        total_supply: u256,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Transfer: Transfer,
        Approval: Approval,
    }

    #[derive(Drop, starknet::Event)]
    struct Transfer {
        #[key]
        from: ContractAddress,
        #[key]
        to: ContractAddress,
        value: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct Approval {
        #[key]
        owner: ContractAddress,
        #[key]
        spender: ContractAddress,
        value: u256,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[external(v0)]
    fn name(self: @ContractState) -> felt252 {
        'Mock Wrapped BTC'
    }

    #[external(v0)]
    fn symbol(self: @ContractState) -> felt252 {
        'WBTC'
    }

    #[external(v0)]
    fn decimals(self: @ContractState) -> u8 {
        8
    }

    #[external(v0)]
    fn totalSupply(self: @ContractState) -> u256 {
        self.total_supply.read()
    }

    #[external(v0)]
    fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
        self.balances.read(account)
    }

    // ERC20 compat standard naming
    #[external(v0)]
    fn balanceOf(self: @ContractState, account: ContractAddress) -> u256 {
        self.balances.read(account)
    }

    #[external(v0)]
    fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
        let sender = get_caller_address();
        let current_balance = self.balances.read(sender);
        assert(current_balance >= amount, 'ERC20: transfer > balance');
        self.balances.write(sender, current_balance - amount);
        self.balances.write(recipient, self.balances.read(recipient) + amount);
        self.emit(Transfer { from: sender, to: recipient, value: amount });
        true
    }

    #[external(v0)]
    fn allowance(self: @ContractState, owner: ContractAddress, spender: ContractAddress) -> u256 {
        self.allowances.read((owner, spender))
    }

    #[external(v0)]
    fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
        let owner = get_caller_address();
        self.allowances.write((owner, spender), amount);
        self.emit(Approval { owner, spender, value: amount });
        true
    }

    #[external(v0)]
    fn transferFrom(ref self: ContractState, sender: ContractAddress, recipient: ContractAddress, amount: u256) -> bool {
        let caller = get_caller_address();
        let current_allowance = self.allowances.read((sender, caller));
        assert(current_allowance >= amount, 'ERC20: insufficient allowance');
        self.allowances.write((sender, caller), current_allowance - amount);

        let current_balance = self.balances.read(sender);
        assert(current_balance >= amount, 'ERC20: balance < transfer');
        self.balances.write(sender, current_balance - amount);
        self.balances.write(recipient, self.balances.read(recipient) + amount);
        self.emit(Transfer { from: sender, to: recipient, value: amount });
        true
    }

    #[external(v0)]
    fn faucet_mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
        let supply = self.total_supply.read();
        self.total_supply.write(supply + amount);
        let current_balance = self.balances.read(recipient);
        self.balances.write(recipient, current_balance + amount);
        let zero: ContractAddress = contract_address_const::<0>();
        self.emit(Transfer { from: zero, to: recipient, value: amount });
    }
}
